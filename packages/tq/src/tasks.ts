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
    created_at: row.created_at,
    eligible_at: row.eligible_at ?? null,
    claimed_at: row.claimed_at ?? null,
    completed_at: row.completed_at ?? null,
    dependencies: deps,
  };
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

    const status: TaskStatus = deps.length === 0 ? 'eligible' : 'pending';
    const eligibleAt = status === 'eligible' ? now : null;

    await conn.execute(
      `INSERT INTO tasks
         (id, description, payload, status, parent_id, priority, created_by, created_at, eligible_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.description,
        input.payload !== undefined ? JSON.stringify(input.payload) : null,
        status,
        input.parent_id ?? null,
        input.priority ?? 0,
        input.created_by,
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
        created_at: now,
        eligible_at: eligibleAt,
        claimed_at: null,
        completed_at: null,
      } as TaskRow,
      deps,
    );
  });
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

      const status: TaskStatus = deps.length === 0 ? 'eligible' : 'pending';
      const eligibleAt = status === 'eligible' ? taskTime : null;

      await conn.execute(
        `INSERT INTO tasks
           (id, description, payload, status, parent_id, priority, created_by, created_at, eligible_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          t.description,
          t.payload !== undefined ? JSON.stringify(t.payload) : null,
          status,
          t.parent_id ?? null,
          t.priority ?? 0,
          input.created_by,
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

export async function claim(agentId: string): Promise<ClaimResult> {
  return withCommit(`[claim] by ${agentId}`, async conn => {
    // Lock the highest-priority eligible task
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE status = 'eligible'
       ORDER BY priority DESC, eligible_at ASC
       LIMIT 1
       FOR UPDATE`,
    );

    if (rows.length === 0) return { task: null };

    const row = rows[0]!;
    const now = new Date();

    await conn.execute(
      `UPDATE tasks SET status = 'in_progress', claimed_by = ?, claimed_at = ? WHERE id = ?`,
      [agentId, now, row.id],
    );

    const depsMap = await attachDeps(conn, [row.id]);
    return {
      task: rowToTask({ ...row, status: 'in_progress', claimed_by: agentId, claimed_at: now }, depsMap.get(row.id) ?? []),
    };
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
    const resultPayload = { error: reason };
    await conn.execute(
      `UPDATE tasks SET status = 'failed', result_payload = ?, completed_at = ? WHERE id = ?`,
      [JSON.stringify(resultPayload), now, taskId],
    );

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      { ...row, status: 'failed', result_payload: resultPayload, completed_at: now },
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
      pending: 0, eligible: 0, in_progress: 0, completed: 0, failed: 0, total: tasks.length,
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
