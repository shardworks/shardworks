import mysql from 'mysql2/promise';
import type { PoolConnection } from 'mysql2/promise';

const host = process.env.DOLT_HOST ?? 'dolt';
const port = parseInt(process.env.DOLT_PORT ?? '3306', 10);

export const pool = mysql.createPool({
  host,
  port,
  user: 'root',
  database: 'shardworks',
  waitForConnections: true,
  connectionLimit: 10,
  // Return dates as Date objects rather than strings
  dateStrings: false,
});

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
 * Acquire a connection, run `fn` in a transaction, then create a Dolt
 * version commit with the given message. The MySQL transaction and the
 * Dolt commit are separate operations; a failed Dolt commit is logged
 * but does not roll back the MySQL changes.
 */
export async function withCommit<T>(
  commitMessage: string,
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    const result = await withTransaction(conn, fn);
    try {
      await conn.execute("CALL dolt_add('-A')");
      await conn.execute('CALL dolt_commit(?)', [
        `-m ${commitMessage} --author "Queue Server <queue@shardworks>"`,
      ]);
    } catch (commitErr) {
      // Non-fatal: MySQL changes are already committed.
      console.warn('[dolt] commit failed (possibly nothing to commit):', commitErr);
    }
    return result;
  } finally {
    conn.release();
  }
}
