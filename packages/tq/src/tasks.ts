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
  TaskDbRow,
} from '@shardworks/shared-types';
import { pool, withCommit, withTransaction } from './db.js';
import { generateId, generateChildId } from './id.js';

// ---------------------------------------------------------------------------
// BriefTask — lightweight projection for --brief flag
// ---------------------------------------------------------------------------

export interface BriefTask {
  id: string;
  description: string;
  status: TaskStatus;
  priority: number;
  assigned_role: string | null;
  parent_id: string | null;
  claimed_by: string | null;
}

// ---------------------------------------------------------------------------
// Row → Task conversion
// ---------------------------------------------------------------------------

// TaskDbRow (from @shardworks/shared-types) is the single source of truth for
// the tasks table schema.  Extending it here adds the mysql2 RowDataPacket
// marker so that typed execute<TaskRow[]>() calls work correctly.
interface TaskRow extends RowDataPacket, TaskDbRow {}

function parseJson(val: unknown): unknown {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val ?? null;
}

async function attachDeps(conn: PoolConnection, taskIds: string[], asOf?: string): Promise<Map<string, string[]>> {
  if (taskIds.length === 0) return new Map();
  const placeholders = taskIds.map(() => '?').join(',');
  const asOfClause = asOf ? ` AS OF '${asOf}'` : '';
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT task_id, dep_id FROM task_dependencies${asOfClause} WHERE task_id IN (${placeholders})`,
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
    result_payload: parseJson(row.result_payload) as Task['result_payload'],
    result_summary: parseJson(row.result_summary) as Task['result_summary'],
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

function rowToBriefTask(row: RowDataPacket): BriefTask {
  return {
    id: row['id'] as string,
    description: row['description'] as string,
    status: row['status'] as TaskStatus,
    priority: row['priority'] as number,
    assigned_role: (row['assigned_role'] as string | null) ?? null,
    parent_id: (row['parent_id'] as string | null) ?? null,
    claimed_by: (row['claimed_by'] as string | null) ?? null,
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
  // Only redirect to children that share the same assigned_role (NULL-safe).
  // Without this, a planner claiming a planner-assigned parent would get
  // silently redirected to NULL-assigned implementer children.
  const roleCondition = taskRow.assigned_role === null
    ? 'assigned_role IS NULL'
    : 'assigned_role = ?';
  const roleParam = taskRow.assigned_role === null ? [] : [taskRow.assigned_role];

  const [childRows] = await conn.execute<TaskRow[]>(
    `SELECT * FROM tasks
     WHERE parent_id = ? AND status = 'eligible' AND ${roleCondition}
     ORDER BY priority DESC, eligible_at ASC
     LIMIT 1
     FOR UPDATE`,
    [taskRow.id, ...roleParam],
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

    for (const tag of input.tags ?? []) {
      await conn.execute(
        'INSERT INTO task_tags (task_id, tag) VALUES (?, ?)',
        [id, tag],
      );
    }

    return rowToTask(
      {
        id, description: input.description,
        payload: input.payload ?? null, status,
        parent_id: input.parent_id ?? null,
        priority: input.priority ?? 0,
        result_payload: null,
        result_summary: null,
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

export async function getTask(id: string, fullResult = false, branch?: string): Promise<Task | null> {
  const conn = await pool.getConnection();
  try {
    const asOfClause = branch ? ` AS OF '${branch}'` : '';
    const [rows] = await conn.execute<TaskRow[]>(`SELECT * FROM tasks${asOfClause} WHERE id = ?`, [id]);
    if (rows.length === 0) return null;
    const depsMap = await attachDeps(conn, [id], branch);
    const task = rowToTask(rows[0]!, depsMap.get(id) ?? []);
    // When fullResult is false (default), omit result_payload if result_summary is present.
    // This keeps the default output compact after compaction while --full-result
    // lets callers retrieve the original output from the live DB.
    if (!fullResult && task.result_summary !== null) {
      task.result_payload = null;
    }
    return task;
  } finally {
    conn.release();
  }
}

export interface ListFilters {
  status?: TaskStatus;
  parent_id?: string;
  created_by?: string;
  assigned_role?: string | null;
}

export async function listTasks(filters: ListFilters = {}, branch?: string, brief?: boolean): Promise<Task[] | BriefTask[]> {
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
    if (filters.assigned_role !== undefined) {
      if (filters.assigned_role === null) {
        conditions.push('assigned_role IS NULL');
      } else {
        conditions.push('assigned_role = ?'); params.push(filters.assigned_role);
      }
    }

    const asOfClause = branch ? ` AS OF '${branch}'` : '';
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    if (brief) {
      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, description, status, priority, assigned_role, parent_id, claimed_by FROM tasks${asOfClause} ${where} ORDER BY priority DESC, created_at ASC`,
        params,
      );
      return rows.map(r => rowToBriefTask(r));
    }

    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks${asOfClause} ${where} ORDER BY priority DESC, created_at ASC`,
      params,
    );

    const ids = rows.map(r => r.id);
    const depsMap = await attachDeps(conn, ids, branch);
    return rows.map(r => rowToTask(r, depsMap.get(r.id) ?? []));
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// T05b — Human-flagged task view
// ---------------------------------------------------------------------------

/** Structured context extracted from a sentinel task description. */
export interface HumanTaskEntry {
  task: Task;
  /** Alert type parsed from the description (e.g. "rate_limited", "crashed"). */
  alert_type: string | null;
  /** Task ID referenced in the description (the task that triggered the alert). */
  referenced_task_id: string | null;
  /** Full referenced task object, if found. */
  referenced_task: Task | null;
  /** Path to the work log for the referenced task. */
  work_log_path: string | null;
}

/**
 * Parse alert_type and referenced_task_id out of a sentinel task description.
 * Sentinel format: "⚠ Human attention needed [<type>]: <msg>"
 * msg often contains "task <id>" or "task_id=<id>".
 */
function parseSentinelDescription(desc: string): {
  alert_type: string | null;
  referenced_task_id: string | null;
} {
  const typeMatch = desc.match(/\[([a-z_]+)\]/i);
  const taskIdMatch = desc.match(/\btask\s+(tq-[a-z0-9]+)\b/i)
    ?? desc.match(/task_id[=:\s]+(tq-[a-z0-9]+)/i);
  return {
    alert_type: typeMatch ? typeMatch[1]! : null,
    referenced_task_id: taskIdMatch ? taskIdMatch[1]! : null,
  };
}

/**
 * List all tasks with assigned_role='human', enriched with alert context,
 * the referenced task object, and the work log path.
 *
 * By default only returns non-terminal tasks (excludes completed/cancelled/failed).
 * Pass `includeResolved: true` to include all statuses.
 */
export async function listHumanTasks(includeResolved = false): Promise<HumanTaskEntry[]> {
  const conn = await pool.getConnection();
  try {
    const statusFilter = includeResolved
      ? ''
      : `AND status NOT IN ('completed', 'cancelled', 'failed')`;
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE assigned_role = 'human' ${statusFilter}
       ORDER BY priority DESC, created_at ASC`,
      [],
    );

    const ids = rows.map(r => r.id);
    const depsMap = await attachDeps(conn, ids);
    const tasks = rows.map(r => rowToTask(r, depsMap.get(r.id) ?? []));

    // Collect all unique referenced task IDs to batch-fetch them
    const parsed = tasks.map(t => parseSentinelDescription(t.description));
    const refIds = [...new Set(parsed.map(p => p.referenced_task_id).filter((id): id is string => id !== null))];

    const refTaskMap = new Map<string, Task>();
    if (refIds.length > 0) {
      const placeholders = refIds.map(() => '?').join(',');
      const [refRows] = await conn.execute<TaskRow[]>(
        `SELECT * FROM tasks WHERE id IN (${placeholders})`,
        refIds,
      );
      const refDepsMap = await attachDeps(conn, refIds);
      for (const row of refRows) {
        refTaskMap.set(row.id, rowToTask(row, refDepsMap.get(row.id) ?? []));
      }
    }

    return tasks.map((task, i) => {
      const { alert_type, referenced_task_id } = parsed[i]!;
      const referenced_task = referenced_task_id ? (refTaskMap.get(referenced_task_id) ?? null) : null;
      return {
        task,
        alert_type,
        referenced_task_id,
        referenced_task,
        work_log_path: referenced_task_id ? `data/work-logs/${referenced_task_id}.jsonl` : null,
      };
    });
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
      `SELECT t.id, COALESCE(t.result_summary, t.result_payload) AS result_payload
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

      for (const tag of t.tags ?? []) {
        await conn.execute(
          'INSERT INTO task_tags (task_id, tag) VALUES (?, ?)',
          [id, tag],
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

export async function claim(agentId: string, capabilities: string[] = [], draft = false, role?: string, branch?: string): Promise<ClaimResult> {
  const targetStatus = draft ? 'draft' : 'eligible';
  const orderBy = draft
    ? 'priority DESC, created_at ASC'
    : 'priority DESC, eligible_at ASC';

  // Role filter:
  // - "implementer" role → claim tasks assigned to implementer OR unassigned (NULL).
  //   Unassigned tasks are implicitly implementer work.
  // - "refiner" role → claim tasks assigned to refiner OR unassigned (NULL).
  //   Unassigned draft tasks are implicitly refiner work, symmetric with implementer.
  // - any other role (e.g. "planner") → exact match only, no NULL fallback.
  //   This prevents planners from hijacking unassigned tasks.
  // - no role specified → only claim tasks with assigned_role IS NULL.
  const roleCondition = (role === 'implementer' || role === 'refiner')
    ? '(assigned_role = ? OR assigned_role IS NULL)'
    : role
      ? 'assigned_role = ?'
      : 'assigned_role IS NULL';
  const roleParams = role ? [role] : [];

  // Capability filter:
  // Only claim tasks whose required tags are a subset of the agent's capabilities.
  // If no capabilities provided, claim any task regardless of tags.
  // SQL: tasks with no tags that are outside the capability set
  //   (i.e. all tags must be in the capability set, or the task has no tags at all).
  let capabilityCondition = '';
  const capabilityParams: string[] = [];
  if (capabilities.length > 0) {
    const placeholders = capabilities.map(() => '?').join(', ');
    capabilityCondition = ` AND NOT EXISTS (
      SELECT 1 FROM task_tags
      WHERE task_id = tasks.id AND tag NOT IN (${placeholders})
    )`;
    capabilityParams.push(...capabilities);
  }

  return withCommit(`[claim${draft ? '-draft' : ''}] by ${agentId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE status = ? AND ${roleCondition}${capabilityCondition}
       ORDER BY ${orderBy}
       LIMIT 1
       FOR UPDATE`,
      [targetStatus, ...roleParams, ...capabilityParams],
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
  }, branch);
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
// T09b — Heartbeat
// ---------------------------------------------------------------------------

/**
 * Refresh claimed_at on an in_progress task to signal the agent is still alive.
 * Validates that the task is in_progress and claimed by the given agentId.
 */
export async function heartbeat(taskId: string, agentId: string): Promise<Task> {
  return withCommit(`[heartbeat] ${taskId} by ${agentId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id = ? FOR UPDATE`,
      [taskId],
    );
    if (rows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = rows[0]!;
    if (row.status !== 'in_progress') {
      throw new Error(`Task ${taskId} is not in_progress (status: ${row.status})`);
    }
    if (row.claimed_by !== agentId) {
      throw new Error(`Task ${taskId} is not claimed by ${agentId} (claimed by ${row.claimed_by})`);
    }

    const now = new Date();
    await conn.execute(
      `UPDATE tasks SET claimed_at = ? WHERE id = ?`,
      [now, taskId],
    );

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      { ...row, claimed_at: now },
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
  resultSummary?: string,
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
      `UPDATE tasks SET status = 'completed', result_payload = ?, result_summary = ?, completed_at = ? WHERE id = ?`,
      [
        resultPayload !== undefined ? JSON.stringify(resultPayload) : null,
        resultSummary !== undefined ? resultSummary : null,
        now,
        taskId,
      ],
    );

    await promoteEligible(conn, taskId);

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      { ...row, status: 'completed', result_payload: resultPayload ?? null, result_summary: resultSummary ?? null, completed_at: now },
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
    if (row.status !== 'in_progress' && row.status !== 'draft')
      throw new Error(`Task ${taskId} cannot be published (status: ${row.status})`);
    if (row.status === 'in_progress' && row.claimed_by !== agentId)
      throw new Error(`Task ${taskId} is not claimed by ${agentId}`);

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
// Reject — operator tool to reset completed/failed task for re-execution
// ---------------------------------------------------------------------------

/**
 * Reset a completed or failed task back to eligible/pending so it can be
 * re-executed.  This is an operator-only escape hatch — no agent ownership
 * check is performed.
 *
 * - result_payload, result_summary, claimed_by, claimed_at, completed_at are
 *   all cleared.
 * - attempt_count is reset to 0.
 * - If the task was failed, any blocked dependents are un-blocked via
 *   promoteUnblocked() so they can wait normally for the re-run.
 * - The new status is 'eligible' when all deps are completed, 'pending' when
 *   at least one dep is still in flight.
 */
export async function rejectTask(taskId: string, actorId: string, reason?: string): Promise<Task> {
  return withCommit(`[reject] ${taskId} by ${actorId}`, async conn => {
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id = ? FOR UPDATE`,
      [taskId],
    );
    if (rows.length === 0) throw new Error(`Task not found: ${taskId}`);
    const row = rows[0]!;
    if (row.status !== 'completed' && row.status !== 'failed') {
      throw new Error(
        `Task ${taskId} cannot be rejected (status: ${row.status}). ` +
        `Only completed or failed tasks can be rejected.`,
      );
    }

    const wasFailed = row.status === 'failed';

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

    // Store the rejection reason in result_payload so there is an audit trail
    const rejectRecord = reason ? JSON.stringify({ rejected_by: actorId, reason }) : null;

    await conn.execute(
      `UPDATE tasks
       SET status = ?, attempt_count = 0, claimed_by = NULL, claimed_at = NULL,
           completed_at = NULL, result_payload = ?, result_summary = NULL,
           eligible_at = ?
       WHERE id = ?`,
      [newStatus, rejectRecord, newStatus === 'eligible' ? now : null, taskId],
    );

    // Un-block tasks that were blocked solely because this task had failed
    if (wasFailed) {
      await promoteUnblocked(conn, taskId);
    }

    const depsMap = await attachDeps(conn, [taskId]);
    return rowToTask(
      {
        ...row,
        status: newStatus,
        attempt_count: 0,
        claimed_by: null,
        claimed_at: null,
        completed_at: null,
        result_payload: rejectRecord ? JSON.parse(rejectRecord) : null,
        result_summary: null,
        eligible_at: newStatus === 'eligible' ? now : null,
      },
      depsMap.get(taskId) ?? [],
    );
  });
}

// ---------------------------------------------------------------------------
// T12 — Subtree + ready
// ---------------------------------------------------------------------------

export async function subtree(parentId: string, brief?: boolean): Promise<SubtreeResult | { tasks: BriefTask[]; rollup: StatusRollup }> {
  const conn = await pool.getConnection();
  try {
    // Verify parent exists
    const [parentRows] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM tasks WHERE id = ?',
      [parentId],
    );
    if (parentRows.length === 0) throw new Error(`Task not found: ${parentId}`);

    if (brief) {
      const [rows] = await conn.execute<RowDataPacket[]>(
        `WITH RECURSIVE sub AS (
           SELECT id, description, status, priority, assigned_role, parent_id, claimed_by FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id, t.description, t.status, t.priority, t.assigned_role, t.parent_id, t.claimed_by FROM tasks t JOIN sub s ON t.parent_id = s.id
         )
         SELECT * FROM sub WHERE id != ?
         ORDER BY priority DESC`,
        [parentId, parentId],
      );
      const tasks = rows.map(r => rowToBriefTask(r));
      const rollup: StatusRollup = {
        draft: 0, pending: 0, eligible: 0, in_progress: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, total: tasks.length,
      };
      for (const t of tasks) rollup[t.status]++;
      return { tasks, rollup };
    }

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

export async function ready(branch?: string, brief?: boolean): Promise<Task[] | BriefTask[]> {
  const conn = await pool.getConnection();
  try {
    const asOfClause = branch ? ` AS OF '${branch}'` : '';

    if (brief) {
      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, description, status, priority, assigned_role, parent_id, claimed_by FROM tasks${asOfClause} WHERE status = 'eligible' ORDER BY priority DESC, eligible_at ASC`,
      );
      return rows.map(r => rowToBriefTask(r));
    }

    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks${asOfClause} WHERE status = 'eligible' ORDER BY priority DESC, eligible_at ASC`,
    );
    const ids = rows.map(r => r.id);
    const depsMap = await attachDeps(conn, ids, branch);
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
// T-release-timed-out — Auto-release tasks whose timeout_seconds has elapsed
// ---------------------------------------------------------------------------

export interface ReleaseTimedOutResult {
  /** Tasks that were found timed out. */
  timed_out: Task[];
  /** Tasks re-queued as eligible (attempts remaining). */
  released: Task[];
  /** Tasks moved to failed (attempts exhausted). */
  failed: Task[];
}

/**
 * Find all in_progress tasks where timeout_seconds IS NOT NULL and
 * claimed_at + INTERVAL timeout_seconds SECOND < NOW().
 *
 * For each timed-out task:
 *  - Increments attempt_count.
 *  - If attempts remain  → status = 'eligible', eligible_at = NOW(),
 *    result_payload = { error: 'timeout', attempt, retrying: true }.
 *  - If attempts exhausted → status = 'failed',
 *    result_payload = { error: 'timeout' }, cascadeBlocked().
 *
 * Safe to run via cron or as an operator command; no daemon required.
 */
export async function releaseTimedOut(): Promise<ReleaseTimedOutResult> {
  return withCommit('[release-timed-out] auto-release timed-out in_progress tasks', async conn => {
    // Fetch all in_progress tasks whose timeout window has elapsed.
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks
       WHERE status = 'in_progress'
         AND timeout_seconds IS NOT NULL
         AND claimed_at + INTERVAL timeout_seconds SECOND < NOW()
       ORDER BY claimed_at ASC
       FOR UPDATE`,
    );

    if (rows.length === 0) {
      return { timed_out: [], released: [], failed: [] };
    }

    const now = new Date();
    const releasedRows: TaskRow[] = [];
    const failedRows: TaskRow[] = [];

    for (const row of rows) {
      const newAttemptCount = (row.attempt_count ?? 0) + 1;
      const maxAttempts = row.max_attempts ?? 1;

      if (newAttemptCount < maxAttempts) {
        // Attempts remain — backoff and return to eligible
        const backoffMs = Math.pow(2, newAttemptCount - 1) * 30_000;
        const eligibleAt = new Date(now.getTime() + backoffMs);
        const resultPayload = { error: 'timeout', attempt: newAttemptCount, retrying: true };
        await conn.execute(
          `UPDATE tasks
           SET status = 'eligible',
               attempt_count = ?,
               eligible_at = ?,
               result_payload = ?,
               claimed_by = NULL,
               claimed_at = NULL,
               completed_at = NULL
           WHERE id = ?`,
          [newAttemptCount, eligibleAt, JSON.stringify(resultPayload), row.id],
        );
        releasedRows.push({
          ...row,
          status: 'eligible',
          attempt_count: newAttemptCount,
          eligible_at: eligibleAt,
          result_payload: resultPayload,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
        });
      } else {
        // Attempts exhausted — terminal failure
        const resultPayload = { error: 'timeout' };
        await conn.execute(
          `UPDATE tasks
           SET status = 'failed',
               attempt_count = ?,
               result_payload = ?,
               completed_at = ?
           WHERE id = ?`,
          [newAttemptCount, JSON.stringify(resultPayload), now, row.id],
        );
        await cascadeBlocked(conn, row.id);
        failedRows.push({
          ...row,
          status: 'failed',
          attempt_count: newAttemptCount,
          result_payload: resultPayload,
          completed_at: now,
        });
      }
    }

    const allIds = rows.map(r => r.id);
    const depsMap = await attachDeps(conn, allIds);

    const timed_out = rows.map(r => rowToTask(r, depsMap.get(r.id) ?? []));
    const released = releasedRows.map(r => rowToTask(r, depsMap.get(r.id) ?? []));
    const failed = failedRows.map(r => rowToTask(r, depsMap.get(r.id) ?? []));

    return { timed_out, released, failed };
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

// ---------------------------------------------------------------------------
// Status counts — aggregate task counts by status
// ---------------------------------------------------------------------------

/**
 * Return a StatusRollup showing how many tasks exist in each status.
 * If `tag` is provided, only tasks with that tag in task_tags are counted.
 */
export async function statusCounts(tag?: string): Promise<StatusRollup> {
  const conn = await pool.getConnection();
  try {
    interface CountRow extends RowDataPacket { status: string; cnt: number; }
    let rows: CountRow[];
    if (tag) {
      [rows] = await conn.execute<CountRow[]>(
        `SELECT t.status, COUNT(*) AS cnt
         FROM tasks t
         JOIN task_tags tt ON tt.task_id = t.id AND tt.tag = ?
         GROUP BY t.status`,
        [tag],
      );
    } else {
      [rows] = await conn.execute<CountRow[]>(
        `SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status`,
      );
    }

    const rollup: StatusRollup = {
      draft: 0, pending: 0, eligible: 0, in_progress: 0,
      completed: 0, failed: 0, cancelled: 0, blocked: 0, total: 0,
    };
    for (const row of rows) {
      const status = row.status as keyof Omit<StatusRollup, 'total'>;
      if (status in rollup) {
        rollup[status] = Number(row.cnt);
      }
      rollup.total += Number(row.cnt);
    }
    return rollup;
  } finally {
    conn.release();
  }
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

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

export interface TaskDiffEntry {
  diff_type: 'added' | 'modified' | 'removed';
  id: string;
  from_status: string | null;
  to_status: string | null;
  from_description: string | null;
  to_description: string | null;
  from_priority: number | null;
  to_priority: number | null;
  from_claimed_by: string | null;
  to_claimed_by: string | null;
  from_assigned_role: string | null;
  to_assigned_role: string | null;
}

interface DiffRow extends RowDataPacket {
  diff_type: string;
  from_id: string | null;
  to_id: string | null;
  from_status: string | null;
  to_status: string | null;
  from_description: string | null;
  to_description: string | null;
  from_priority: number | null;
  to_priority: number | null;
  from_claimed_by: string | null;
  to_claimed_by: string | null;
  from_assigned_role: string | null;
  to_assigned_role: string | null;
}

/**
 * Validate a Dolt commit ref: allows hex hashes, branch/tag names with
 * alphanumerics, dots, dashes, underscores, slashes, and carets (for HEAD^).
 * Rejects anything that could form a SQL injection.
 */
function validateCommitRef(ref: string): string {
  if (!/^[a-zA-Z0-9._\-/^~@{}:]+$/.test(ref)) {
    throw new Error(`Invalid commit ref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/**
 * Return all task rows that changed between two Dolt commits.
 * Uses the DOLT_DIFF() table function for multi-commit range support.
 * Both fromCommit and toCommit can be commit hashes, branch names, or tags.
 *
 * Note: DOLT_DIFF() table function arguments cannot be parameterised with
 * bind variables; the refs are validated and inlined as string literals.
 */
export async function diff(fromCommit: string, toCommit: string): Promise<TaskDiffEntry[]> {
  const safeFrom = validateCommitRef(fromCommit);
  const safeTo   = validateCommitRef(toCommit);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute<DiffRow[]>(
      `SELECT
         diff_type,
         from_id,
         to_id,
         from_status,
         to_status,
         from_description,
         to_description,
         from_priority,
         to_priority,
         from_claimed_by,
         to_claimed_by,
         from_assigned_role,
         to_assigned_role
       FROM DOLT_DIFF('${safeFrom}', '${safeTo}', 'tasks')
       ORDER BY COALESCE(to_id, from_id) ASC`,
    );

    return rows.map((r) => ({
      diff_type: r.diff_type as 'added' | 'modified' | 'removed',
      id: (r.to_id ?? r.from_id) as string,
      from_status: r.from_status ?? null,
      to_status: r.to_status ?? null,
      from_description: r.from_description ?? null,
      to_description: r.to_description ?? null,
      from_priority: r.from_priority ?? null,
      to_priority: r.to_priority ?? null,
      from_claimed_by: r.from_claimed_by ?? null,
      to_claimed_by: r.to_claimed_by ?? null,
      from_assigned_role: r.from_assigned_role ?? null,
      to_assigned_role: r.to_assigned_role ?? null,
    }));
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------

export interface CompactResult {
  compacted: string[];
  skipped: string[];
}

/**
 * Compact one or more completed tasks: write result_summary, null out result_payload.
 *
 * @param taskId   - The root task to compact.
 * @param summary  - Caller-provided summary value (stored as result_summary).
 * @param actor    - Agent/user performing the operation.
 * @param subtree  - When true, also compact all completed descendants.
 */
export async function compact(
  taskId: string,
  summary: unknown,
  actor: string,
  subtreeMode = false,
): Promise<CompactResult> {
  return withCommit(`[compact] ${taskId} by ${actor}`, async conn => {
    // Gather all target task IDs
    const targetIds: string[] = [taskId];

    if (subtreeMode) {
      const [descRows] = await conn.execute<RowDataPacket[]>(
        `WITH RECURSIVE sub AS (
           SELECT id, parent_id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id, t.parent_id FROM tasks t JOIN sub s ON t.parent_id = s.id
         )
         SELECT id FROM sub WHERE id != ?`,
        [taskId, taskId],
      );
      for (const r of descRows) targetIds.push(r.id as string);
    }

    // Lock all rows
    const placeholders = targetIds.map(() => '?').join(',');
    const [rows] = await conn.execute<TaskRow[]>(
      `SELECT * FROM tasks WHERE id IN (${placeholders}) FOR UPDATE`,
      targetIds,
    );

    // Validate root task exists
    const rootRow = rows.find(r => r.id === taskId);
    if (!rootRow) throw new Error(`Task not found: ${taskId}`);

    const compacted: string[] = [];
    const skipped: string[] = [];
    const summaryJson = JSON.stringify(summary);

    for (const row of rows) {
      if (row.status !== 'completed') {
        skipped.push(row.id);
        continue;
      }
      await conn.execute(
        `UPDATE tasks SET result_summary = ?, result_payload = NULL WHERE id = ?`,
        [summaryJson, row.id],
      );
      compacted.push(row.id);
    }

    // If root wasn't completed (and thus skipped), treat as error unless subtree mode
    if (!subtreeMode && skipped.includes(taskId)) {
      throw new Error(`Task ${taskId} is not completed (status: ${rootRow.status})`);
    }

    return { compacted, skipped };
  });
}

// ---------------------------------------------------------------------------
// branch operations
// ---------------------------------------------------------------------------

/**
 * Validate a Dolt branch name: alphanumerics, dots, dashes, underscores,
 * forward slashes. Rejects anything that could form a SQL injection.
 */
function validateBranchName(name: string): string {
  if (!/^[a-zA-Z0-9._\-/]+$/.test(name)) {
    throw new Error(`Invalid branch name: ${JSON.stringify(name)}`);
  }
  return name;
}

export interface BranchConflict {
  table: string;
  num_conflicts: number;
}

export interface BranchMergeResult {
  source: string;
  target: string;
  fast_forward: boolean;
  conflicts: BranchConflict[];
}

interface MergeRow extends RowDataPacket {
  fast_forward: number | null;
  conflicts: number | null;
  message?: string | null;
}

interface ConflictRow extends RowDataPacket {
  table_name: string;
  num_conflicts: number;
}

/**
 * Merge `source` branch into `target` branch.
 *
 * Steps:
 *  1. CALL dolt_checkout(target)
 *  2. CALL dolt_merge(source)
 *  3. If there are conflicts, query dolt_conflicts to surface them
 *     and return {conflicts: [...]} without throwing.
 *
 * Returns a BranchMergeResult with fast_forward flag and conflicts list.
 * A successful no-conflict merge returns conflicts: [].
 */
export async function branchMerge(source: string, target: string): Promise<BranchMergeResult> {
  const safeSrc = validateBranchName(source);
  const safeTgt = validateBranchName(target);
  const conn = await pool.getConnection();
  try {
    // Switch to target branch
    await conn.execute('CALL dolt_checkout(?)', [safeTgt]);

    // Attempt merge — dolt_merge returns a result set even on conflict
    let fastForward = false;
    let mergeConflicts = 0;
    try {
      const [results] = await conn.execute<MergeRow[]>(
        'CALL dolt_merge(?)',
        [safeSrc],
      );
      const row = Array.isArray(results) ? results[0] : null;
      if (row) {
        fastForward = Boolean(row.fast_forward);
        mergeConflicts = typeof row.conflicts === 'number' ? row.conflicts : 0;
      }
    } catch (err) {
      // dolt_merge may throw when there are conflicts; treat as conflicted merge
      const message = err instanceof Error ? err.message : String(err);
      // Re-throw if it's not a merge conflict error
      if (!/conflict/i.test(message) && !/merge/i.test(message)) {
        throw err;
      }
      mergeConflicts = 1; // will query actual counts below
    }

    // If conflicts reported, query dolt_conflicts for details
    const conflicts: BranchConflict[] = [];
    if (mergeConflicts > 0) {
      const [conflictRows] = await conn.execute<ConflictRow[]>(
        `SELECT table_name, COUNT(*) AS num_conflicts
           FROM dolt_conflicts
          GROUP BY table_name`,
      );
      for (const r of conflictRows) {
        conflicts.push({ table: r.table_name, num_conflicts: Number(r.num_conflicts) });
      }
    }

    return {
      source: safeSrc,
      target: safeTgt,
      fast_forward: fastForward,
      conflicts,
    };
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Branch create / list
// ---------------------------------------------------------------------------

export interface BranchInfo {
  name: string;
  hash: string;
  latest_committer: string | null;
  latest_committer_email: string | null;
  latest_commit_date: Date | null;
  latest_commit_message: string | null;
  remote: string | null;
  branch: string | null;
}

interface BranchRow extends RowDataPacket {
  name: string;
  hash: string;
  latest_committer: string | null;
  latest_committer_email: string | null;
  latest_commit_date: Date | null;
  latest_commit_message: string | null;
  remote: string | null;
  branch: string | null;
}

export interface BranchCreateResult {
  ok: true;
  name: string;
  from?: string;
}

export interface BranchDeleteResult {
  ok: true;
  deleted: string;
}

/**
 * Create a new Dolt branch.
 * If `from` is provided, copies that branch: CALL dolt_branch('-c', from, name).
 * Otherwise creates from HEAD: CALL dolt_branch(name).
 * Wrapped in withCommit for consistent connection management.
 */
export async function branchCreate(name: string, from?: string): Promise<BranchCreateResult> {
  const safeName = validateBranchName(name);
  const safeFrom = from !== undefined ? validateBranchName(from) : undefined;
  return withCommit(`[branch create] ${safeName}${safeFrom ? ` from ${safeFrom}` : ''}`, async conn => {
    if (safeFrom !== undefined) {
      await conn.execute('CALL dolt_branch(?, ?, ?)', ['-c', safeFrom, safeName]);
    } else {
      await conn.execute('CALL dolt_branch(?)', [safeName]);
    }
    const result: BranchCreateResult = { ok: true, name: safeName };
    if (safeFrom !== undefined) result.from = safeFrom;
    return result;
  });
}

/**
 * Delete a Dolt branch by name.
 * Refuses to delete the 'main' branch.
 * Calls: CALL dolt_branch('-d', name)
 */
export async function branchDelete(name: string): Promise<BranchDeleteResult> {
  const safeName = validateBranchName(name);
  if (safeName === 'main') {
    throw new Error("Refusing to delete the 'main' branch.");
  }
  const conn = await pool.getConnection();
  try {
    await conn.execute('CALL dolt_branch(?, ?)', ['-d', safeName]);
    return { ok: true, deleted: safeName };
  } finally {
    conn.release();
  }
}

/**
 * List all Dolt branches by querying the dolt_branches system table.
 */
export async function branchList(): Promise<BranchInfo[]> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute<BranchRow[]>('SELECT * FROM dolt_branches ORDER BY name ASC');
    return rows.map(r => ({
      name: r.name,
      hash: r.hash,
      latest_committer: r.latest_committer ?? null,
      latest_committer_email: r.latest_committer_email ?? null,
      latest_commit_date: r.latest_commit_date ?? null,
      latest_commit_message: r.latest_commit_message ?? null,
      remote: r.remote ?? null,
      branch: r.branch ?? null,
    }));
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

export interface TaskHistoryEntry {
  commit_hash: string;
  committer: string;
  message: string;
  from_status: string | null;
  to_status: string | null;
  committed_at: Date;
}

interface HistoryRow extends RowDataPacket {
  commit_hash: string;
  committer: string;
  message: string;
  from_status: string | null;
  to_status: string | null;
  committed_at: Date;
}

/**
 * Return all Dolt commits that modified the row for `taskId` in the `tasks`
 * table, ordered oldest → newest.  Each entry includes the commit hash,
 * committer, commit message, and the before/after status of the task.
 */
export async function history(taskId: string): Promise<TaskHistoryEntry[]> {
  const conn = await pool.getConnection();
  try {
    // Verify task exists
    const [taskRows] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM tasks WHERE id = ?',
      [taskId],
    );
    if (taskRows.length === 0) throw new Error(`Task not found: ${taskId}`);

    const [rows] = await conn.execute<HistoryRow[]>(
      `SELECT
         l.commit_hash,
         l.committer,
         l.message,
         d.from_status,
         d.to_status,
         l.date AS committed_at
       FROM dolt_diff_tasks d
       JOIN dolt_log l ON l.commit_hash = d.to_commit
       WHERE d.to_id = ? OR d.from_id = ?
       ORDER BY l.commit_order ASC`,
      [taskId, taskId],
    );

    return rows.map((r) => ({
      commit_hash: r.commit_hash,
      committer: r.committer,
      message: r.message,
      from_status: r.from_status ?? null,
      to_status: r.to_status ?? null,
      committed_at: r.committed_at,
    }));
  } finally {
    conn.release();
  }
}
