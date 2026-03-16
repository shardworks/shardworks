import { pool } from './db.js';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id             VARCHAR(64)  NOT NULL PRIMARY KEY,
    description    TEXT         NOT NULL,
    payload        JSON,
    status         VARCHAR(32)  NOT NULL DEFAULT 'pending',
    parent_id      VARCHAR(64),
    priority       INT          NOT NULL DEFAULT 0,
    result_payload JSON,
    created_by     VARCHAR(255) NOT NULL,
    claimed_by     VARCHAR(255),
    created_at     DATETIME(3)  NOT NULL,
    eligible_at    DATETIME(3),
    claimed_at     DATETIME(3),
    completed_at   DATETIME(3)
  )`,
  `CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id  VARCHAR(64) NOT NULL,
    dep_id   VARCHAR(64) NOT NULL,
    PRIMARY KEY (task_id, dep_id)
  )`,
];

export async function initSchema(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    for (const sql of STATEMENTS) {
      await conn.execute(sql);
    }
    console.log('[schema] Tables ready.');
  } finally {
    conn.release();
  }
}
