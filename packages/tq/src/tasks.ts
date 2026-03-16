import type { RowDataPacket, PoolConnection } from 'mysql2/promise';
import type {
  Task,
  TaskStatus,
  StatusRollup,
  EnqueueInput,
  BatchEnqueueInput,
  ClaimResult,
  SubtreeResult,
  DepResults,
  TaskRelationship,
  RelationshipType,
} from '@shardworks/shared-types';
import { pool, withCommit, withTransaction } from './db.js';
import { generateId, generateChildId } from './id.js';

// ---------------------------------------------------------------------------
// Row → Task conversion
// ---------------------------------------------------------------------------

interface TaskRow extends RowDataPacket {
  id: string;
  description: string;
  payload: unknown;
  status: string;
  parent_id: string | null;
  priority: number;
  result_payload: unknown;
  created_by: string;
  claimed_by: string | null;
  assigned_role: string | null;
  max_attempts: number;
  attempt_count: number;
  timeout_seconds: number | null;
  created_at: Date;
  eligible_at: Date | null;
  claimed_at: Date | null;
  completed_at: Date | null;
}

function parseJson(val: unknown): unknown {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val ?? null;
}

async function attachDeps(conn: PoolConnection, taskIds: string[]): Promise<Map<string, string[]>> {
  if (taskIds.length === 0) return new Map();
  const placeholders = taskIds.map(() => '?').join(',');
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT task_id, dep_id FROM task_dependencies WHERE task_id IN (${placeholders})`,
    taskIds,
  );
  const map = new Map<string, string[]>(taskIds.map(id => [id, []]));
  for (const row of rows) {
    map.get(row.task_id as string)?.push(row.dep_id as string);
  }
  return map;
}

function rowToTask(row: TaskRow, deps: string[]): Task {
  return {
    id: row.id,
    description: row.description,
    payload: parseJson(row.payload),
    status: row.status as TaskStatus,
    parent_id: row.parent_id ?? null,
    priority: row.priority,
    result_payload: parseJson(row.result_payload),
    created_by: row.created_by,
    claimed_by: row.claimed_by ?? null,
    assigned_role: row.assigned_role ?? null,
    max_attempts: row.max_attempts ?? 1,
    attempt_count: row.attempt_count ?? 0,
    timeout_seconds: row.timeout_seconds ?? null,
    created_at: row.created_at,
    eligible_at: row.eligible_at ?? null,
    claimed_at: row.claimed_at ?? null,
    completed_at: row.completed_at ?? null,
    dependencies: deps,
  };
}

// ---------------------------------------------------------------------------
// Child-delegation helper
// ---------------------------------------------------------------------------

/**
 * Follows eligible-child redirects: if `taskRow` has eligible direct children,
 * returns the highest-priority eligible descendant (the deepest "leaf" in the
 * eligible subtree).  All SELECTs use FOR UPDATE so they participate in the
 * caller's transaction and prevent concurrent claims of the same child.
 */
async function findEligibleLeaf(conn: PoolConnection, taskRow: TaskRow): Promise<TaskRow> {
  const [childRows] = await conn.execute<TaskRow[]>(
    `SELECT * FROM tasks
     WHERE parent_id = ? AND status = 'eligible'
     ORDER BY priority DESC, eligible_at ASC
     LIMIT 1
     FOR UPDATE`,
    [taskRow.id],
  );
  if (childRows.length === 0) return taskRow;
  return findEligibleLeaf(conn, childRows[0]!);
}

// ---------------------------------------------------------------------------
// T05 — Enqueue + get + list
// ---------------------------------------------------------------------------

export async function enqueue(input: EnqueueInput): Promise<Task> {
  return withCommit(`[enqueue] by ${input.created_by}`, async conn => {
    const now = new Date();
    const deps = input.dependencies ?? [];

    // Verify all dep IDs exist
    if (deps.length > 0) {
      const placeholders = deps.map(() => '?').join(',');
      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM tasks WHERE id IN (${placeholders})`,
        deps,
      );
      if (rows.length !== deps.length) {
        const found = new Set(rows.map(r => r.id as string));
        const missing = deps.filter(d => !found.has(d));
        throw new Error(`Unknown dependency IDs: ${missing.join(', ')}`);
      }
    }

    // Verify parent exists if specified
    if (input.parent_id) {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT id FROM tasks WHERE id = ?',
        [input.parent_id],
      );
      if (rows.length === 0) throw new Error(`Parent task not found: ${input.parent_id}`);
    }

    // DAG validation: a true cycle is impossible on single enqueue since the
    // new task doesn't exist yet and can't be referenced. However, we check
    // that the declared deps don't contain contradictions — i.e. one dep
    // already transitively depends on another dep, which is redundant and
    // likely a mistake.
    if (deps.length > 1) {
      const reachable = await reachableFrom(conn, deps);
      for (const depId of deps) {
        if (reachable.has(depId)) {
          // One of the other deps already transitively depends on this dep.
          // Find which one for a useful error message.
          for (const otherDep of deps) {
            if (otherDep === depId) continue;
            const otherReachable = await reachableFrom(conn, [otherDep]);
            if (otherReachable.has(depId)) {
              throw new Error(
                `Redundant dependency: ${otherDep} already transitively depends on ${depId}`,
              );
            }
          }
        }
      }
    }

    const id = input.parent_id
      ? generateChildId(input.parent_id, input.description, input.created_by, now)
      : generateId(input.description, input.created_by, now);

    const status: TaskStatus = input.skipDraft
      ? (deps.length === 0 ? 'eligible' : 'pending')
      : 'draft';
    const eligibleAt = status === 'eligible' ? now : null;

    await conn.execute(
      `INSERT INTO tasks
         (id, description, payload, status, parent_id, priority, created_by, assigned_role, created_at, eligible_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.description,
        input.payload !== undefined ? JSON.stringify(input.payload) : null,
        status,
        input.parent_id ?? null,
        input.priority ?? 0,
        input.created_by,
        input.assigned_role ?? null,
        now,
        eligibleAt,
      ],
    );

    for (const depId of deps) {
      await conn.execute(
        'INSERT INTO task_dependencies (task_id, dep_id) VALUES (?, ?)',
        [id, depId],
      );
    }

    return rowToTask(
      {
        id, description: input.description,
        payload: input.payload ?? null, status,
        parent_id: input.parent_id ?? null,
        priority: input.priority ?? 0,
        result_payload: null,
        created_by: input.created_by,
        claimed_by: null,
        assigned_role: input.assigned_role ?? null,
        created_at: now,
        eligible_at: eligibleAt,
        claimed_at: null,
        completed_at: null,
      } as TaskRow,
      deps,
    );
  });
}

/** Returns the highest priority value among all tasks, or 0 if no tasks exist. */
export async function getMaxPriority(): Promise<number> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute<RowDataPacket[]>(
      'SELECT COALESCE(MAX(priority), 0) AS max_priority FROM tasks',
    );
    return Number(rows[0]?.['max_priority'] ?? 0);
  } finally {
    conn.release();
  }
}

export async function getTask(id: string): Promise<Task | null> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute<TaskRow[]>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    const depsMap = await attachDeps(conn, [id]);
    return rowToTask(rows[0]!, depsMap.get(id) ?? []);
  } finally {
    conn.release();
  }
}

export interface ListFilters {
  status?: TaskStatus;
  parent_id?: string;
  created_by?: string;
}

export async function listTasks(filters: ListFilters = {}): Promise<Task[]> {
  const conn = await pool.getConnection();
  try {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];

    if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
    if (filters.parent_id !== undefined) {
      if (filters.parent_id === '') {
        conditions.push('parent_id IS NULL');
      } else {
        conditions.push('parent_id = ?'); params.push(filters.parent_id);
      }
    }
    if (filters.created_by) { conditions.push('created_by = ?'); params.push(filters.created_by); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at ASC`,
      params,
    );

    const ids = rows.map(r => r.id);
    const depsMap = await attachDeps(conn, ids);
    return rows.map(r => rowToTask(r, depsMap.get(r.id) ?? []));
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// T06 — Dependency DAG + dep results
// ---------------------------------------------------------------------------

/** Returns dep_ids of all tasks reachable from `startIds` (for cycle detection). */
async function reachableFrom(conn: PoolConnection, startIds: string[]): Promise<Set<string>> {
  const visited = new Set<string>();
  const queue = [...startIds];
  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length);
    const placeholders = batch.map(() => '?').join(',');
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT dep_id FROM task_dependencies WHERE task_id IN (${placeholders})`,
      batch,
    );
    for (const row of rows) {
      const dep = row.dep_id as string;
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }
  return visited;
}

/** Look up a task's parent_id. Returns null if the task has no parent or doesn't exist. */
async function getParentId(conn: PoolConnection, taskId: string): Promise<string | null> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    'SELECT parent_id FROM tasks WHERE id = ?',
    [taskId],
  );
  return rows.length > 0 ? (rows[0]!.parent_id as string | null) : null;
}

export async function getDepResults(taskId: string): Promise<DepResults> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT t.id, t.result_payload
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.dep_id
       WHERE td.task_id = ?`,
      [taskId],
    );
    const result: DepResults = {};
    for (const row of rows) {
      result[row.id as string] = parseJson(row.result_payload);
    }
    return result;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// T07 — Eligibility promotion
// ---------------------------------------------------------------------------

/**
 * After a task completes, promote any dependents whose deps are now all done.
 * Must be called within an open connection (can be inside a transaction).
 */
async function promoteEligible(conn: PoolConnection, completedTaskId: string): Promise<void> {
  const now = new Date();

  // Tasks that directly depend on the just-completed task
  const [candidates] = await conn.execute<RowDataPacket[]>(
    `SELECT task_id FROM task_dependencies WHERE dep_id = ?`,
    [completedTaskId],
  );

  for (const { task_id } of candidates) {
    // Check if ALL dependencies of this candidate are completed
    const [depRows] = await conn.execute<RowDataPacket[]>(
      `SELECT t.status
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.dep_id
       WHERE td.task_id = ?`,
      [task_id],
    );
    const allDone = depRows.every(r => r.status === 'completed');
    if (allDone) {
      await conn.execute(
        `UPDATE tasks SET status = 'eligible', eligible_at = ? WHERE id = ? AND status = 'pending'`,
        [now, task_id],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// T08 — Batch enqueue
// ---------------------------------------------------------------------------

/**
 * Topological sort to detect cycles and determine insertion order.
 * Returns sorted client_ids, or throws if a cycle is detected.
 */
function topoSort(tasks: BatchEnqueueInput['tasks']): string[] {
  const clientIds = new Set(tasks.map(t => t.client_id));
  const internalDeps = new Map<string, string[]>(
    tasks.map(t => [
      t.client_id,
      (t.dependencies ?? []).filter(d => clientIds.has(d)),
    ]),
  );

  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cycle detected in batch involving client_id: ${id}`);
    visiting.add(id);
    for (const dep of internalDeps.get(id) ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
    sorted.push(id);
  }

  for (const { client_id } of tasks) visit(client_id);
  return sorted;
}

export async function batchEnqueue(input: BatchEnqueueInput): Promise<Task[]> {
  const order = topoSort(input.tasks);
  const tasksByClientId = new Map(input.tasks.map(t => [t.client_id, t]));
  const clientToRealId = new Map<string, string>();
  const results: Task[] = [];

  return withCommit(`[batch-enqueue] ${input.tasks.length} tasks by ${input.created_by}`, async conn => {
    const now = new Date();

    for (const clientId of order) {
      const t = tasksByClientId.get(clientId)!;
      const deps = (t.dependencies ?? []).map(d => clientToRealId.get(d) ?? d);

      // Verify external deps exist (deps already resolved to real IDs)
      const batchRealIds = new Set(clientToRealId.values());
      const externalDepIds = deps.filter(d => !batchRealIds.has(d));
      if (externalDepIds.length > 0) {
        const placeholders = externalDepIds.map(() => '?').join(',');
        const [rows] = await conn.execute<RowDataPacket[]>(
          `SELECT id FROM tasks WHERE id IN (${placeholders})`,
          externalDepIds,
        );
        if (rows.length !== externalDepIds.length) {
          const found = new Set(rows.map(r => r.id as string));
          const missing = externalDepIds.filter(d => !found.has(d));
          throw new Error(`Unknown dependency IDs: ${missing.join(', ')}`);
        }
      }

      if (t.parent_id) {
        const [rows] = await conn.execute<RowDataPacket[]>(
          'SELECT id FROM tasks WHERE id = ?',
          [t.parent_id],
        );
        if (rows.length === 0) throw new Error(`Parent task not found: ${t.parent_id}`);
      }

      // Use slightly offset timestamps so IDs in the same batch don't collide
      const taskTime = new Date(now.getTime() + results.length);
      const id = t.parent_id
        ? generateChildId(t.parent_id, t.description, input.created_by, taskTime)
        : generateId(t.description, input.created_by, taskTime);

      clientToRealId.set(clientId, id);

      const status: TaskStatus = input.skipDraft
        ? (deps.length === 0 ? 'eligible' : 'pending')
        : 'draft';
      const eligibleAt = status === 'eligible' ? taskTime : null;

      await conn.execute(
        `INSERT INTO tasks
           (id, description, payload, status, parent_id, priority, created_by, assigned_role, created_at, eligible_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          t.description,
          t.payload !== undefined ? JSON.stringify(t.payload) : null,
          status,
          t.parent_id ?? null,
          t.priority ?? 0,
          input.created_by,
          t.assigned_role ?? null,
          taskTime,
          eligibleAt,
        ],
      );

      for (const depId of deps) {
        await conn.execute(
          'INSERT INTO task_dependencies (task_id, dep_id) VALUES (?, ?)',
          [id, depId],
        );
      }

      results.push(rowToTask(
        {
          id, description: t.description,
          payload: t.payload ?? null, status,
          parent_id: t.parent_id ?? null,
          priority: t.priority ?? 0,
          result_payload: null,
          created_by: input.created_by,
          claimed_by: null,
          assigned_role: t.assigned_role ?? null,
          created_at: taskTime,
          eligible_at: eligibleAt,
          claimed_at: null,
          completed_at: null,
        } as TaskRow,
        deps,
      ));
    }

    return results;
  });
}

// ---------------------------------------------------------------------------
// T09 — Claim (no tag routing for MVP)
// ---------------------------------------------------------------------------

export async function claim(agentId: string, draft = false, role?: string): Promise<ClaimResult> {
  const targetStatus = draft ? 'draft' : 'eligible';
  const orderBy = draft
    ? 'priority DESC, created_at ASC'
    : 'priority DESC, eligible_at ASC';

  // Role filter: if a role is specified, match tasks with that assigned_role OR no assigned_role.
  // If no role is specified, only match tasks with no assigned_role (backward-compatible).
  const roleCondition = role
    ? '(assigned_role IS NULL OR assigned_role = ?)'
    : 'assigned_role IS NULL';
  const roleParams = role ? [role] : [];

  return withCommit(`[claim${draft ? '-draft' : ''}] by ${agentId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE status = ? AND ${roleCondition}
       ORDER BY ${orderBy}
       LIMIT 1
       FOR UPDATE`,
      [targetStatus, ...roleParams],
    );

    if (rows.length === 0) return { task: null };

    const row = rows[0]!;

    // For eligible tasks: if this task has eligible children, implement the
    // highest-priority eligible descendant instead of the parent directly.
    const targetRow = draft ? row : await findEligibleLeaf(conn, row);

    const now = new Date();
    await conn.execute(
      `UPDATE tasks SET status = 'in_progress', claimed_by = ?, claimed_at = ? WHERE id = ?`,
      [agentId, now, targetRow.id],
    );

    const depsMap = await attachDeps(conn, [targetRow.id]);
    return {
      task: rowToTask({ ...targetRow, status: 'in_progress', claimed_by: agentId, claimed_at: now }, depsMap.get(targetRow.id) ?? []),
    };
  });
}

// ---------------------------------------------------------------------------
// T09b — Claim by ID
// ---------------------------------------------------------------------------

export async function claimById(taskId: string, agentId: string, draft = false): Promise<ClaimResult> {
  const allowedStatuses = draft ? ['eligible', 'draft'] : ['eligible'];
  return withCommit(`[claim-id] ${taskId} by ${agentId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id = ? FOR UPDATE`,
      [taskId],
    );

    if (rows.length === 0) throw new Error(`Task not found: ${taskId}`);

    const row = rows[0]!;
    if (!allowedStatuses.includes(row.status)) {
      throw new Error(
        `Task ${taskId} cannot be claimed: status is '${row.status}' (expected ${allowedStatuses.join(' or ')})`,
      );
    }

    // For eligible tasks: if this task has eligible children, redirect to the
    // highest-priority eligible descendant instead of claiming the parent.
    const targetRow = row.status === 'eligible' ? await findEligibleLeaf(conn, row) : row;

    const now = new Date();
    await conn.execute(
      `UPDATE tasks SET status = 'in_progress', claimed_by = ?, claimed_at = ? WHERE id = ?`,
      [agentId, now, targetRow.id],
    );

    const depsMap = await attachDeps(conn, [targetRow.id]);
    return {
      task: rowToTask({ ...targetRow, status: 'in_progress', claimed_by: agentId, claimed_at: now }, depsMap.get(targetRow.id) ?? []),
    };
  });
}

// ---------------------------------------------------------------------------
// T09c — Release (return in_progress → eligible)
// ---------------------------------------------------------------------------

/**
 * Release a claimed task back to `eligible` so another worker can pick it up.
 * Used when a worker is interrupted (rate limit, crash recovery, etc.) and
 * wants to relinquish the task without failing it.
 *
 * @param force — if true, skip the agent-ownership check (for operators/reapers)
 */
export async function release(taskId: string, agentId: string, force = false): Promise<Task> {
  return withCommit(`[release] ${taskId} by ${agentId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id = ? FOR UPDATE`,
      [taskId],
    );
    if (rows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = rows[0]!;
    if (row.status !== 'in_progress') {
      throw new Error(`Task ${taskId} is not in_progress (status: ${row.status})`);
    }
    if (!force && row.claimed_by !== agentId) {
      throw new Error(`Task ${taskId} is not claimed by ${agentId} (claimed by ${row.claimed_by})`);
    }

    const now = new Date();
    await conn.execute(
      `UPDATE tasks SET status = 'eligible', eligible_at = ?, claimed_by = NULL, claimed_at = NULL WHERE id = ?`,
      [now, taskId],
    );

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      { ...row, status: 'eligible', eligible_at: now, claimed_by: null, claimed_at: null },
      depsMap.get(taskId) ?? [],
    );
  });
}

// ---------------------------------------------------------------------------
// T10 — Complete
// ---------------------------------------------------------------------------

export async function complete(
  taskId: string,
  agentId: string,
  resultPayload?: unknown,
): Promise<Task> {
  return withCommit(`[complete] ${taskId} by ${agentId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id = ? FOR UPDATE`,
      [taskId],
    );
    if (rows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = rows[0]!;
    if (row.status !== 'in_progress') throw new Error(`Task ${taskId} is not in_progress (status: ${row.status})`);
    if (row.claimed_by !== agentId) throw new Error(`Task ${taskId} is not claimed by ${agentId}`);

    const now = new Date();
    await conn.execute(
      `UPDATE tasks SET status = 'completed', result_payload = ?, completed_at = ? WHERE id = ?`,
      [resultPayload !== undefined ? JSON.stringify(resultPayload) : null, now, taskId],
    );

    await promoteEligible(conn, taskId);

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      { ...row, status: 'completed', result_payload: resultPayload ?? null, completed_at: now },
      depsMap.get(taskId) ?? [],
    );
  });
}

// ---------------------------------------------------------------------------
// T07b — Blocked cascade
// ---------------------------------------------------------------------------

/**
 * After a task reaches terminal failed state, recursively mark all pending/eligible
 * dependents as blocked (they can no longer proceed without a retry of this task).
 */
async function cascadeBlocked(conn: PoolConnection, failedTaskId: string): Promise<void> {
  // Use a worklist to process transitive dependents iteratively
  const toProcess = [failedTaskId];
  const seen = new Set<string>();

  while (toProcess.length > 0) {
    const current = toProcess.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);

    const [candidates] = await conn.execute<RowDataPacket[]>(
      `SELECT task_id FROM task_dependencies WHERE dep_id = ?`,
      [current],
    );

    for (const { task_id } of candidates) {
      if (seen.has(task_id)) continue;
      await conn.execute(
        `UPDATE tasks SET status = 'blocked' WHERE id = ? AND status IN ('pending', 'eligible')`,
        [task_id],
      );
      toProcess.push(task_id);
    }
  }
}

// ---------------------------------------------------------------------------
// T11 — Fail
// ---------------------------------------------------------------------------

export async function fail(
  taskId: string,
  agentId: string,
  reason: string,
): Promise<Task> {
  return withCommit(`[fail] ${taskId} by ${agentId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id = ? FOR UPDATE`,
      [taskId],
    );
    if (rows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = rows[0]!;
    if (row.status !== 'in_progress') throw new Error(`Task ${taskId} is not in_progress (status: ${row.status})`);
    if (row.claimed_by !== agentId) throw new Error(`Task ${taskId} is not claimed by ${agentId}`);

    const now = new Date();
    const newAttemptCount = (row.attempt_count ?? 0) + 1;
    const maxAttempts = row.max_attempts ?? 1;

    if (newAttemptCount < maxAttempts) {
      // Attempts remain — backoff and return to eligible
      const backoffMs = Math.pow(2, newAttemptCount - 1) * 30_000;
      const eligibleAt = new Date(now.getTime() + backoffMs);
      const resultPayload = { error: reason, attempt: newAttemptCount, retrying: true };
      await conn.execute(
        `UPDATE tasks SET status = 'eligible', attempt_count = ?, eligible_at = ?,
         result_payload = ?, claimed_by = NULL, claimed_at = NULL, completed_at = NULL WHERE id = ?`,
        [newAttemptCount, eligibleAt, JSON.stringify(resultPayload), taskId],
      );
      const depsMap = await attachDeps(conn, [taskId]);
      return rowToTask(
        { ...row, status: 'eligible', attempt_count: newAttemptCount, eligible_at: eligibleAt,
          result_payload: resultPayload, claimed_by: null, claimed_at: null, completed_at: null },
        depsMap.get(taskId) ?? [],
      );
    }

    // No attempts remain — terminal failure
    const resultPayload = { error: reason };
    await conn.execute(
      `UPDATE tasks SET status = 'failed', attempt_count = ?, result_payload = ?, completed_at = ? WHERE id = ?`,
      [newAttemptCount, JSON.stringify(resultPayload), now, taskId],
    );

    await cascadeBlocked(conn, taskId);

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      { ...row, status: 'failed', attempt_count: newAttemptCount, result_payload: resultPayload, completed_at: now },
      depsMap.get(taskId) ?? [],
    );
  });
}

// ---------------------------------------------------------------------------
// Publish — task-refiner marks a draft task ready for regular workers
// ---------------------------------------------------------------------------

/**
 * Transitions a draft task from in_progress → eligible or pending.
 * Called by task-refiner agents after they have refined a ticket.
 * The agent must be the one that claimed the task.
 */
export async function publish(taskId: string, agentId: string): Promise<Task> {
  return withCommit(`[publish] ${taskId} by ${agentId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id = ? FOR UPDATE`,
      [taskId],
    );
    if (rows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = rows[0]!;
    if (row.status !== 'in_progress') throw new Error(`Task ${taskId} is not in_progress (status: ${row.status})`);
    if (row.claimed_by !== agentId) throw new Error(`Task ${taskId} is not claimed by ${agentId}`);

    // Determine eligibility based on whether all existing dependencies are completed
    const [depRows] = await conn.execute<RowDataPacket[]>(
      `SELECT t.status
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.dep_id
       WHERE td.task_id = ?`,
      [taskId],
    );
    const allDone = depRows.length === 0 || depRows.every(r => r.status === 'completed');
    const now = new Date();
    const newStatus: TaskStatus = allDone ? 'eligible' : 'pending';
    const eligibleAt = allDone ? now : null;

    await conn.execute(
      `UPDATE tasks SET status = ?, eligible_at = ?, claimed_by = NULL, claimed_at = NULL WHERE id = ?`,
      [newStatus, eligibleAt, taskId],
    );

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      { ...row, status: newStatus, eligible_at: eligibleAt, claimed_by: null, claimed_at: null },
      depsMap.get(taskId) ?? [],
    );
  });
}

// ---------------------------------------------------------------------------
// Planner operations — atomic cross-task mutations
// ---------------------------------------------------------------------------

/**
 * Add a dependency edge: `taskId` depends on `depId`.
 * Validates both tasks exist, the edge doesn't already exist, and no cycle
 * would be created. Only allowed on tasks that are draft, pending, or eligible
 * (not in_progress/completed/failed — those are locked to their current DAG).
 */
export async function link(taskId: string, depId: string, actor: string): Promise<Task> {
  return withCommit(`[link] ${taskId} → ${depId} by ${actor}`, async conn => {
    // Lock both tasks
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id IN (?, ?) FOR UPDATE`,
      [taskId, depId],
    );
    const taskRow = rows.find(r => r.id === taskId);
    const depRow = rows.find(r => r.id === depId);
    if (!taskRow) throw new Error(`Task not found: ${taskId}`);
    if (!depRow) throw new Error(`Task not found: ${depId}`);

    const mutableStatuses = new Set(['draft', 'pending', 'eligible']);
    if (!mutableStatuses.has(taskRow.status)) {
      throw new Error(`Cannot add dependency to ${taskId}: status is ${taskRow.status} (must be draft, pending, or eligible)`);
    }

    // Check for existing edge
    const [existing] = await conn.execute<RowDataPacket[]>(
      'SELECT 1 FROM task_dependencies WHERE task_id = ? AND dep_id = ?',
      [taskId, depId],
    );
    if (existing.length > 0) throw new Error(`Dependency ${taskId} → ${depId} already exists`);

    // Cycle detection: can depId reach taskId transitively? If so, adding this edge creates a cycle.
    const reachable = await reachableFrom(conn, [depId]);
    if (reachable.has(taskId)) {
      throw new Error(`Adding dependency ${taskId} → ${depId} would create a cycle`);
    }

    await conn.execute(
      'INSERT INTO task_dependencies (task_id, dep_id) VALUES (?, ?)',
      [taskId, depId],
    );

    // If the task was eligible but now has an incomplete dependency, demote to pending
    if (taskRow.status === 'eligible' && depRow.status !== 'completed') {
      await conn.execute(
        `UPDATE tasks SET status = 'pending', eligible_at = NULL WHERE id = ?`,
        [taskId],
      );
      taskRow.status = 'pending';
      taskRow.eligible_at = null;
    }

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(taskRow, depsMap.get(taskId) ?? []);
  });
}

/**
 * Remove a dependency edge. If the task was pending and all remaining deps
 * are now completed, promotes it to eligible.
 */
export async function unlink(taskId: string, depId: string, actor: string): Promise<Task> {
  return withCommit(`[unlink] ${taskId} → ${depId} by ${actor}`, async conn => {
    const [taskRows] = await conn.execute<TaskRow[]>(
      'SELECT * FROM tasks WHERE id = ? FOR UPDATE',
      [taskId],
    );
    if (taskRows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = taskRows[0]!;

    const mutableStatuses = new Set(['draft', 'pending', 'eligible']);
    if (!mutableStatuses.has(row.status)) {
      throw new Error(`Cannot remove dependency from ${taskId}: status is ${row.status}`);
    }

    const [existing] = await conn.execute<RowDataPacket[]>(
      'SELECT 1 FROM task_dependencies WHERE task_id = ? AND dep_id = ?',
      [taskId, depId],
    );
    if (existing.length === 0) throw new Error(`No dependency ${taskId} → ${depId} exists`);

    await conn.execute(
      'DELETE FROM task_dependencies WHERE task_id = ? AND dep_id = ?',
      [taskId, depId],
    );

    // Check if the task should be promoted (pending → eligible)
    if (row.status === 'pending') {
      const [depRows] = await conn.execute<RowDataPacket[]>(
        `SELECT t.status
         FROM task_dependencies td
         JOIN tasks t ON t.id = td.dep_id
         WHERE td.task_id = ?`,
        [taskId],
      );
      const allDone = depRows.length === 0 || depRows.every(r => r.status === 'completed');
      if (allDone) {
        const now = new Date();
        await conn.execute(
          `UPDATE tasks SET status = 'eligible', eligible_at = ? WHERE id = ?`,
          [now, taskId],
        );
        row.status = 'eligible';
        row.eligible_at = now;
      }
    }

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(row, depsMap.get(taskId) ?? []);
  });
}

/**
 * Move a task under a new parent. Pass newParentId = null to make it a root task.
 * Prevents circular parent chains.
 */
export async function reparent(taskId: string, newParentId: string | null, actor: string): Promise<Task> {
  const label = newParentId ? `${taskId} → parent ${newParentId}` : `${taskId} → root`;
  return withCommit(`[reparent] ${label} by ${actor}`, async conn => {
    const [taskRows] = await conn.execute<TaskRow[]>(
      'SELECT * FROM tasks WHERE id = ? FOR UPDATE',
      [taskId],
    );
    if (taskRows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = taskRows[0]!;

    if (newParentId !== null) {
      // Verify parent exists
      const [parentRows] = await conn.execute<TaskRow[]>(
        'SELECT id FROM tasks WHERE id = ?',
        [newParentId],
      );
      if (parentRows.length === 0) throw new Error(`Parent task not found: ${newParentId}`);

      // Prevent circular parent chains: walk from newParentId up; if we reach taskId, it's circular
      const visited = new Set<string>();
      let cursor: string | null = newParentId;
      while (cursor !== null) {
        if (cursor === taskId) {
          throw new Error(`Reparenting ${taskId} under ${newParentId} would create a circular parent chain`);
        }
        if (visited.has(cursor)) break; // safety: shouldn't happen but avoids infinite loop
        visited.add(cursor);
        cursor = await getParentId(conn, cursor);
      }
    }

    await conn.execute(
      'UPDATE tasks SET parent_id = ? WHERE id = ?',
      [newParentId, taskId],
    );
    row.parent_id = newParentId;

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(row, depsMap.get(taskId) ?? []);
  });
}

/**
 * Edit mutable fields (description, payload, priority) on a task that hasn't
 * been claimed yet. At least one field must be provided.
 */
export async function edit(
  taskId: string,
  actor: string,
  updates: { description?: string; payload?: unknown; priority?: number; assigned_role?: string | null },
): Promise<Task> {
  if (updates.description === undefined && updates.payload === undefined && updates.priority === undefined && updates.assigned_role === undefined) {
    throw new Error('At least one of description, payload, priority, or assigned_role must be provided');
  }

  return withCommit(`[edit] ${taskId} by ${actor}`, async conn => {
    const [taskRows] = await conn.execute<TaskRow[]>(
      'SELECT * FROM tasks WHERE id = ? FOR UPDATE',
      [taskId],
    );
    if (taskRows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = taskRows[0]!;

    const mutableStatuses = new Set(['draft', 'pending', 'eligible']);
    if (!mutableStatuses.has(row.status)) {
      throw new Error(`Cannot edit ${taskId}: status is ${row.status} (must be draft, pending, or eligible)`);
    }

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (updates.description !== undefined) {
      sets.push('description = ?');
      params.push(updates.description);
      row.description = updates.description;
    }
    if (updates.payload !== undefined) {
      sets.push('payload = ?');
      params.push(JSON.stringify(updates.payload));
      row.payload = updates.payload;
    }
    if (updates.priority !== undefined) {
      sets.push('priority = ?');
      params.push(updates.priority);
      row.priority = updates.priority;
    }
    if (updates.assigned_role !== undefined) {
      sets.push('assigned_role = ?');
      params.push(updates.assigned_role);
      row.assigned_role = updates.assigned_role;
    }
    params.push(taskId);

    await conn.execute(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(row, depsMap.get(taskId) ?? []);
  });
}

/**
 * Cancel a task without claiming it first. Used by planners to eliminate
 * duplicates or remove tasks that are no longer needed. Only works on tasks
 * that are not in_progress (to avoid stomping on active workers).
 */
export async function cancel(taskId: string, actor: string, reason: string): Promise<Task> {
  return withCommit(`[cancel] ${taskId} by ${actor}`, async conn => {
    const [taskRows] = await conn.execute<TaskRow[]>(
      'SELECT * FROM tasks WHERE id = ? FOR UPDATE',
      [taskId],
    );
    if (taskRows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = taskRows[0]!;

    if (row.status === 'in_progress') {
      throw new Error(`Cannot cancel ${taskId}: it is in_progress (claimed by ${row.claimed_by})`);
    }
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      throw new Error(`Cannot cancel ${taskId}: it is already ${row.status}`);
    }

    const now = new Date();
    const resultPayload = { cancelled: true, cancelled_by: actor, reason };
    await conn.execute(
      `UPDATE tasks SET status = 'cancelled', result_payload = ?, completed_at = ? WHERE id = ?`,
      [JSON.stringify(resultPayload), now, taskId],
    );

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      { ...row, status: 'cancelled', result_payload: resultPayload, completed_at: now },
      depsMap.get(taskId) ?? [],
    );
  });
}

// ---------------------------------------------------------------------------
// Retry — re-queue a failed or blocked task
// ---------------------------------------------------------------------------

/**
 * After a retried task is no longer failed, un-block any tasks that were
 * blocked solely because of it.
 */
async function promoteUnblocked(conn: PoolConnection, retriedTaskId: string): Promise<void> {
  const now = new Date();

  const [candidates] = await conn.execute<RowDataPacket[]>(
    `SELECT task_id FROM task_dependencies WHERE dep_id = ?`,
    [retriedTaskId],
  );

  for (const { task_id } of candidates) {
    const [depRows] = await conn.execute<RowDataPacket[]>(
      `SELECT t.status
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.dep_id
       WHERE td.task_id = ?`,
      [task_id],
    );
    // A blocked task can be unblocked if none of its deps are in a terminal non-completed state
    const hasTerminalBlocker = depRows.some(
      r => r.status === 'failed' || r.status === 'cancelled',
    );
    const allDone = depRows.every(r => r.status === 'completed');
    if (!hasTerminalBlocker && !allDone) {
      // Deps are pending/eligible/in_progress — restore to pending so it waits normally
      await conn.execute(
        `UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'blocked'`,
        [task_id],
      );
    } else if (allDone) {
      await conn.execute(
        `UPDATE tasks SET status = 'eligible', eligible_at = ? WHERE id = ? AND status = 'blocked'`,
        [now, task_id],
      );
    }
  }
}

export async function retryTask(taskId: string, actorId: string): Promise<Task> {
  return withCommit(`[retry] ${taskId} by ${actorId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id = ? FOR UPDATE`,
      [taskId],
    );
    if (rows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = rows[0]!;
    if (row.status !== 'failed' && row.status !== 'blocked') {
      throw new Error(`Task ${taskId} cannot be retried (status: ${row.status})`);
    }

    // Check whether all dependencies are satisfied
    const [depRows] = await conn.execute<RowDataPacket[]>(
      `SELECT t.status
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.dep_id
       WHERE td.task_id = ?`,
      [taskId],
    );
    const allDepsCompleted = depRows.every(r => r.status === 'completed');
    const newStatus = allDepsCompleted ? 'eligible' : 'pending';
    const now = new Date();

    await conn.execute(
      `UPDATE tasks
       SET status = ?, attempt_count = 0, claimed_by = NULL, claimed_at = NULL,
           completed_at = NULL, result_payload = NULL,
           eligible_at = ?
       WHERE id = ?`,
      [newStatus, newStatus === 'eligible' ? now : null, taskId],
    );

    await promoteUnblocked(conn, taskId);

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      { ...row, status: newStatus, attempt_count: 0, claimed_by: null, claimed_at: null,
        completed_at: null, result_payload: null, eligible_at: newStatus === 'eligible' ? now : null },
      depsMap.get(taskId) ?? [],
    );
  });
}

// ---------------------------------------------------------------------------
// T12 — Subtree + ready
// ---------------------------------------------------------------------------

export async function subtree(parentId: string): Promise<SubtreeResult> {
  const conn = await pool.getConnection();
  try {
    // Verify parent exists
    const [parentRows] = await conn.execute<TaskRow[]>(
      'SELECT * FROM tasks WHERE id = ?',
      [parentId],
    );
    if (parentRows.length === 0) throw new Error(`Task not found: ${parentId}`);

    // Recursive CTE — supported by Dolt (MySQL 8+)
    const [rows] = await conn.execute<TaskRow[]>(
      `WITH RECURSIVE sub AS (
         SELECT * FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.* FROM tasks t JOIN sub s ON t.parent_id = s.id
       )
       SELECT * FROM sub WHERE id != ?
       ORDER BY priority DESC, created_at ASC`,
      [parentId, parentId],
    );

    const ids = rows.map(r => r.id);
    const depsMap = await attachDeps(conn, ids);
    const tasks = rows.map(r => rowToTask(r, depsMap.get(r.id) ?? []));

    const rollup: StatusRollup = {
      draft: 0, pending: 0, eligible: 0, in_progress: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, total: tasks.length,
    };
    for (const t of tasks) rollup[t.status]++;

    return { tasks, rollup };
  } finally {
    conn.release();
  }
}

export async function ready(): Promise<Task[]> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE status = 'eligible' ORDER BY priority DESC, eligible_at ASC`,
    );
    const ids = rows.map(r => r.id);
    const depsMap = await attachDeps(conn, ids);
    return rows.map(r => rowToTask(r, depsMap.get(r.id) ?? []));
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Reap — find and optionally release stale in_progress tasks
// ---------------------------------------------------------------------------

export interface ReapResult {
  /** Tasks that are stale (in_progress longer than the threshold). */
  stale: Task[];
  /** Tasks that were released (only populated when doRelease=true). */
  released: Task[];
}

/**
 * Find in_progress tasks whose claimed_at is older than `staleAfterMs`.
 * If `doRelease` is true, release them all back to eligible.
 * This is the safety net for orphaned tasks whose workers crashed or
 * whose conductor died.
 */
export async function reap(staleAfterMs: number, doRelease = false): Promise<ReapResult> {
  const cutoff = new Date(Date.now() - staleAfterMs);

  if (!doRelease) {
    // Read-only: just list stale tasks
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute<TaskRow[]>(
        `SELECT * FROM tasks WHERE status = 'in_progress' AND claimed_at < ? ORDER BY claimed_at ASC`,
        [cutoff],
      );
      const ids = rows.map(r => r.id);
      const depsMap = await attachDeps(conn, ids);
      const stale = rows.map(r => rowToTask(r, depsMap.get(r.id) ?? []));
      return { stale, released: [] };
    } finally {
      conn.release();
    }
  }

  // Release mode: release all stale tasks in a single commit
  return withCommit(`[reap] release stale tasks older than ${Math.round(staleAfterMs / 60000)}m`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE status = 'in_progress' AND claimed_at < ? ORDER BY claimed_at ASC FOR UPDATE`,
      [cutoff],
    );

    if (rows.length === 0) return { stale: [], released: [] };

    const now = new Date();
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');

    await conn.execute(
      `UPDATE tasks SET status = 'eligible', eligible_at = ?, claimed_by = NULL, claimed_at = NULL WHERE id IN (${placeholders})`,
      [now, ...ids],
    );

    const depsMap = await attachDeps(conn, ids);
    const released = rows.map(r =>
      rowToTask(
        { ...r, status: 'eligible', eligible_at: now, claimed_by: null, claimed_at: null },
        depsMap.get(r.id) ?? [],
      ),
    );

    return { stale: released, released };
  });
}

// ---------------------------------------------------------------------------
// Typed Relationships (FR-7, FR-21) — non-scheduling annotated edges
// ---------------------------------------------------------------------------

const VALID_RELATIONSHIP_TYPES: Set<string> = new Set([
  'relates_to',
  'duplicates',
  'supersedes',
  'replies_to',
  'spawned_from',
]);

interface RelationshipRow extends RowDataPacket {
  from_task_id: string;
  to_task_id: string;
  relationship_type: string;
  created_by: string;
  created_at: Date;
}

function rowToRelationship(row: RelationshipRow): TaskRelationship {
  return {
    from_task_id: row.from_task_id,
    to_task_id: row.to_task_id,
    relationship_type: row.relationship_type as RelationshipType,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

/**
 * Create an annotated (non-scheduling) relationship between two tasks.
 * Idempotent: re-inserting the same (from, to, type) triple is a no-op.
 */
export async function relate(
  fromTaskId: string,
  toTaskId: string,
  relationshipType: string,
  createdBy: string,
): Promise<TaskRelationship> {
  if (!VALID_RELATIONSHIP_TYPES.has(relationshipType)) {
    throw new Error(
      `Invalid relationship type "${relationshipType}". Valid types: ${[...VALID_RELATIONSHIP_TYPES].join(', ')}`,
    );
  }

  return withCommit(`[relate] ${fromTaskId} -[${relationshipType}]-> ${toTaskId}`, async conn => {
    // Verify both tasks exist
    const [fromRows] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM tasks WHERE id = ?',
      [fromTaskId],
    );
    if (fromRows.length === 0) throw new Error(`Task not found: ${fromTaskId}`);

    const [toRows] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM tasks WHERE id = ?',
      [toTaskId],
    );
    if (toRows.length === 0) throw new Error(`Task not found: ${toTaskId}`);

    const now = new Date();

    // Upsert — ignore duplicate (idempotent)
    await conn.execute(
      `INSERT INTO task_relationships (from_task_id, to_task_id, relationship_type, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE created_at = created_at`,
      [fromTaskId, toTaskId, relationshipType, createdBy, now],
    );

    const [rows] = await conn.execute<RelationshipRow[]>(
      `SELECT * FROM task_relationships WHERE from_task_id = ? AND to_task_id = ? AND relationship_type = ?`,
      [fromTaskId, toTaskId, relationshipType],
    );

    return rowToRelationship(rows[0]!);
  });
}

/**
 * List all typed relationships involving a task (as either source or target).
 * Returns relationships grouped by direction.
 */
export async function getRelations(taskId: string): Promise<{
  outgoing: TaskRelationship[];
  incoming: TaskRelationship[];
}> {
  const conn = await pool.getConnection();
  try {
    // Verify task exists
    const [taskRows] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM tasks WHERE id = ?',
      [taskId],
    );
    if (taskRows.length === 0) throw new Error(`Task not found: ${taskId}`);

    const [outRows] = await conn.execute<RelationshipRow[]>(
      `SELECT * FROM task_relationships WHERE from_task_id = ? ORDER BY created_at ASC`,
      [taskId],
    );

    const [inRows] = await conn.execute<RelationshipRow[]>(
      `SELECT * FROM task_relationships WHERE to_task_id = ? ORDER BY created_at ASC`,
      [taskId],
    );

    return {
      outgoing: outRows.map(rowToRelationship),
      incoming: inRows.map(rowToRelationship),
    };
  } finally {
    conn.release();
  }
}
