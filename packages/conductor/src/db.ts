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
      user: process.env['DOLT_USER'] ?? 'root',
      password: process.env['DOLT_PASSWORD'] ?? '',
      database: process.env['DOLT_DATABASE'] ?? 'shardworks',
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
  /** Total eligible tasks across all roles. */
  eligible: number;
  /** Tasks waiting on dependencies. */
  pending: number;
  /** Completed tasks. */
  completed: number;
  /** Failed tasks. */
  failed: number;
  /** Highest priority among draft tasks (0 if none). Used for priority-aware scheduling. */
  maxDraftPriority: number;
  /** Highest priority among eligible tasks (0 if none). Used for priority-aware scheduling. */
  maxEligiblePriority: number;
  /**
   * Number of non-planner eligible tasks that are parent containers with at least
   * one draft child but no eligible children.  These tasks cannot be implemented
   * until their draft children are refined — the conductor should prefer a refiner
   * over a wasted implementer slot.
   */
  eligibleBlockedByChildren: number;
  /**
   * Eligible task counts broken down by assigned_role.
   * Key '' (empty string) represents tasks with assigned_role IS NULL (unassigned → implementer).
   * e.g. { '': 3, 'evaluator': 5, 'planner': 1 }
   */
  eligibleByRole: Record<string, number>;
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
    completed: 0,
    failed: 0,
    maxDraftPriority: 0,
    maxEligiblePriority: 0,
    eligibleBlockedByChildren: 0,
    eligibleByRole: {},
  };

  for (const row of rows) {
    const n = Number(row['cnt']);
    const maxP = Number(row['max_priority'] ?? 0);
    switch (row['status']) {
      case 'in_progress':
        counts.inProgress += n;
        break;
      case 'draft':
        counts.draft += n;
        if (maxP > counts.maxDraftPriority) counts.maxDraftPriority = maxP;
        break;
      case 'eligible': {
        counts.eligible += n;
        if (maxP > counts.maxEligiblePriority) counts.maxEligiblePriority = maxP;
        // Track per-role breakdown; use '' for tasks with no assigned_role (NULL)
        const roleKey = (row['assigned_role'] as string | null) ?? '';
        counts.eligibleByRole[roleKey] = (counts.eligibleByRole[roleKey] ?? 0) + n;
        break;
      }
      case 'pending':
        counts.pending += n;
        break;
      case 'completed':   counts.completed  += n; break;
      case 'failed':      counts.failed     += n; break;
    }
  }

  // Count eligible non-planner tasks that have draft children but no eligible
  // children — these are parent containers that an implementer cannot work on
  // directly yet (children need refining first).
  try {
    const [blockedRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(DISTINCT t.id) AS cnt
       FROM tasks t
       WHERE t.status = 'eligible'
         AND (t.assigned_role IS NULL OR t.assigned_role != 'planner')
         AND EXISTS (
           SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'draft'
         )
         AND NOT EXISTS (
           SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'eligible'
         )`,
    );
    counts.eligibleBlockedByChildren = Number(blockedRows[0]?.['cnt'] ?? 0);
  } catch {
    // Non-fatal — fall back to 0; worst case we spawn a wasted implementer
  }

  return counts;
}

