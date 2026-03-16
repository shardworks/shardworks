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
    assigned_role  VARCHAR(64),
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
  `CREATE TABLE IF NOT EXISTS task_relationships (
    from_task_id      VARCHAR(64)  NOT NULL,
    to_task_id        VARCHAR(64)  NOT NULL,
    relationship_type VARCHAR(32)  NOT NULL,
    created_by        VARCHAR(255) NOT NULL,
    created_at        DATETIME(3)  NOT NULL,
    PRIMARY KEY (from_task_id, to_task_id, relationship_type)
  )`,
  `CREATE TABLE IF NOT EXISTS task_tags (
    task_id VARCHAR(64) NOT NULL,
    tag     VARCHAR(64) NOT NULL,
    PRIMARY KEY (task_id, tag)
  )`,
];

/** Migrations that may fail if already applied (e.g. column already exists). */
const MIGRATIONS = [
  `ALTER TABLE tasks ADD COLUMN assigned_role VARCHAR(64) AFTER claimed_by`,
  `ALTER TABLE tasks ADD COLUMN max_attempts INT NOT NULL DEFAULT 1 AFTER assigned_role`,
  `ALTER TABLE tasks ADD COLUMN attempt_count INT NOT NULL DEFAULT 0 AFTER max_attempts`,
  `ALTER TABLE tasks ADD COLUMN timeout_seconds INT NULL AFTER attempt_count`,
  `ALTER TABLE tasks ADD COLUMN result_summary JSON NULL AFTER result_payload`,
];

export async function initSchema(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    for (const sql of STATEMENTS) {
      await conn.execute(sql);
    }
    for (const sql of MIGRATIONS) {
      try {
        await conn.execute(sql);
      } catch (err: unknown) {
        // Ignore "already exists" errors — column already exists from a prior migration
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes('already exists')) {
          throw err;
        }
      }
    }
  } finally {
    conn.release();
  }
}
