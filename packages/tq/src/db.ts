import mysql from 'mysql2/promise';
import type { PoolConnection } from 'mysql2/promise';
import {
  createPool,
  withTransaction as _withTransaction,
  checkDoltStatus as _checkDoltStatus,
} from '@shardworks/db';

export const pool = createPool({ connectionLimit: 10 });

/**
 * Run `fn` inside a MySQL transaction on `conn`. Commits on success,
 * rolls back on error.
 */
export async function withTransaction<T>(
  conn: PoolConnection,
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  return _withTransaction(conn, fn);
}

/**
 * Acquire a connection, run `fn` in a transaction, then create a Dolt
 * version commit with the given message.
 *
 * When `branch` is provided, the connection is checked out to that branch
 * before the transaction runs and restored to `main` after the Dolt commit
 * (or on error) so the connection is safe to return to the pool.
 *
 * ⚠️  KNOWN LIMITATION — NON-ATOMIC VERSIONING
 * The MySQL transaction commit (line ~49) and the Dolt commit (lines ~50-62)
 * are two separate, non-atomic operations. This means:
 *
 *  1. If the process crashes or is killed after the MySQL COMMIT succeeds but
 *     before `dolt_commit()` runs, the row changes exist in the working set
 *     but are NOT recorded in Dolt history.
 *
 *  2. If `dolt_commit()` itself fails for any reason (e.g. Dolt internal
 *     error), the failure is logged as a warning but the MySQL changes are
 *     kept — again leaving the working set dirty without a history entry.
 *
 * Consequence: `dolt_diff` / `dolt_log` queries and any rollback via Dolt
 * history will silently miss those changes.
 *
 * Mitigation: Call {@link checkDoltStatus} at startup (or after a restart)
 * to detect and alert on any orphaned uncommitted changes left by a previous
 * crash.
 *
 * A fully atomic solution would require Dolt to support two-phase commit with
 * MySQL, which is not currently available.
 */
export async function withCommit<T>(
  commitMessage: string,
  fn: (conn: PoolConnection) => Promise<T>,
  branch?: string,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    if (branch) {
      await conn.execute('CALL dolt_checkout(?)', [branch]);
    }
    const result = await _withTransaction(conn, fn);
    try {
      // Guard: only commit if there are actual changes in the working set.
      const [statusRows] = await conn.execute<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS cnt FROM dolt_status',
      );
      const dirty = (statusRows[0]?.cnt ?? 0) > 0;
      if (dirty) {
        await conn.execute("CALL dolt_add('-A')");
        await conn.execute(
          'CALL dolt_commit(?, ?, ?, ?)',
          ['-m', commitMessage, '--author', 'Queue Server <queue@shardworks>'],
        );
      }
    } catch (commitErr) {
      // Non-fatal: MySQL changes are already committed.
      console.warn('[dolt] commit failed:', commitErr);
    }
    return result;
  } finally {
    // Always restore to main before returning the connection to the pool,
    // so subsequent callers don't inherit a non-main branch.
    if (branch) {
      await conn.execute('CALL dolt_checkout(?)', ['main']).catch(() => undefined);
    }
    conn.release();
  }
}

/**
 * Health-check: query `dolt_status` and warn if there are uncommitted changes
 * in the Dolt working set.
 *
 * This catches the scenario described in {@link withCommit}'s known-limitation
 * note: a MySQL transaction was committed but the subsequent `dolt_commit()`
 * did not run (e.g. due to a process crash). Those changes are present in the
 * database but invisible to `dolt_diff` / `dolt_log`.
 *
 * Call this once at server startup so operators are alerted immediately after
 * a crash rather than discovering the gap later during an audit.
 *
 * @returns The list of dirty table names, or an empty array if the working set
 *          is clean. Logs a warning for each dirty table.
 */
export async function checkDoltStatus(): Promise<string[]> {
  return _checkDoltStatus(pool);
}
