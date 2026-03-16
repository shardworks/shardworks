import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = mysql.createPool({
      host: process.env['DOLT_HOST'] ?? 'dolt',
      port: parseInt(process.env['DOLT_PORT'] ?? '3306', 10),
      user: 'root',
      database: 'shardworks',
      waitForConnections: true,
      connectionLimit: 5,
      dateStrings: false,
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface TaskCounts {
  /** Tasks currently claimed and being worked on. */
  inProgress: number;
  /** Tasks in draft state, waiting to be refined. */
  draft: number;
  /** Tasks ready to be claimed by implementers (assigned_role IS NULL or 'implementer'). */
  eligible: number;
  /** Tasks waiting on dependencies. */
  pending: number;
  /** Eligible tasks assigned to the planner role specifically. */
  eligiblePlanner: number;
  /** Completed tasks. */
  completed: number;
  /** Failed tasks. */
  failed: number;
  /** Highest priority among draft tasks (0 if none). Used for priority-aware scheduling. */
  maxDraftPriority: number;
  /** Highest priority among non-planner eligible tasks (0 if none). Used for priority-aware scheduling. */
  maxEligiblePriority: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Returns a snapshot of task counts grouped by status and role. */
export async function queryCounts(): Promise<TaskCounts> {
  const pool = getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT
       status,
       assigned_role,
       COUNT(*) AS cnt,
       MAX(priority) AS max_priority
     FROM tasks
     GROUP BY status, assigned_role`,
  );

  const counts: TaskCounts = {
    inProgress: 0,
    draft: 0,
    eligible: 0,
    pending: 0,
    eligiblePlanner: 0,
    completed: 0,
    failed: 0,
    maxDraftPriority: 0,
    maxEligiblePriority: 0,
  };

  for (const row of rows) {
    const n = Number(row['cnt']);
    const maxP = Number(row['max_priority'] ?? 0);
    switch (row['status']) {
      case 'in_progress': counts.inProgress += n; break;
      case 'draft':
        counts.draft += n;
        if (maxP > counts.maxDraftPriority) counts.maxDraftPriority = maxP;
        break;
      case 'eligible':
        counts.eligible += n;
        if (row['assigned_role'] === 'planner') {
          counts.eligiblePlanner += n;
        } else {
          if (maxP > counts.maxEligiblePriority) counts.maxEligiblePriority = maxP;
        }
        break;
      case 'pending':     counts.pending    += n; break;
      case 'completed':   counts.completed  += n; break;
      case 'failed':      counts.failed     += n; break;
    }
  }

  return counts;
}

/**
 * Counts tasks created after the given date.
 * Pass null to count all tasks ever created.
 */
export async function queryTasksSince(since: Date | null): Promise<number> {
  const pool = getPool();
  if (since === null) {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM tasks',
    );
    return Number(rows[0]?.['cnt'] ?? 0);
  }

  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS cnt FROM tasks WHERE created_at > ?',
    [since],
  );
  return Number(rows[0]?.['cnt'] ?? 0);
}
