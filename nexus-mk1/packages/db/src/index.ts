import mysql from 'mysql2/promise';
import type { Pool, PoolConnection } from 'mysql2/promise';

/**
 * Create a mysql2 connection pool reading connection details from environment
 * variables with sensible defaults for the Shardworks Dolt backend.
 *
 * Environment variables:
 *   DOLT_HOST     – hostname (default: "dolt")
 *   DOLT_PORT     – port     (default: 3306)
 *   DOLT_USER     – user     (default: "root")
 *   DOLT_PASSWORD – password (default: "")
 *   DOLT_DATABASE – database (default: "shardworks")
 */
export function createPool(opts?: { connectionLimit?: number }): Pool {
  const host = process.env.DOLT_HOST ?? 'dolt';
  const port = parseInt(process.env.DOLT_PORT ?? '3306', 10);
  const user = process.env.DOLT_USER ?? 'root';
  const password = process.env.DOLT_PASSWORD ?? '';
  const database = process.env.DOLT_DATABASE ?? 'shardworks';

  return mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: opts?.connectionLimit ?? 10,
    dateStrings: false,
  });
}

/**
 * Run `fn` inside a MySQL transaction on `conn`. Commits on success,
 * rolls back on error.
 */
export async function withTransaction<T>(
  conn: PoolConnection,
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

/**
 * Acquire a connection from `pool`, run `fn` in a transaction, then create a
 * Dolt version commit with the given message.
 *
 * ⚠️  KNOWN LIMITATION — NON-ATOMIC VERSIONING
 * The MySQL transaction commit and the Dolt commit are two separate,
 * non-atomic operations. This means:
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
 */
export async function withCommit<T>(
  pool: Pool,
  commitMessage: string,
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    const result = await withTransaction(conn, fn);
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
export async function checkDoltStatus(pool: Pool): Promise<string[]> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT table_name, status FROM dolt_status',
    );
    if (rows.length === 0) {
      return [];
    }
    console.warn(
      '[dolt] ⚠️  Uncommitted changes detected in Dolt working set — ' +
      'a previous withCommit() call may have committed to MySQL without ' +
      'creating a Dolt history entry. Run `dolt_commit` manually or ' +
      'investigate before proceeding.',
    );
    for (const row of rows) {
      console.warn(`[dolt]   ${row.status}\t${row.table_name}`);
    }
    return rows.map((r) => String(r.table_name));
  } finally {
    conn.release();
  }
}
