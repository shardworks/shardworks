import mysql from 'mysql2/promise';
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
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id         VARCHAR(64)  NOT NULL PRIMARY KEY,
    applied_at DATETIME(3)  NOT NULL
  )`,
];

/**
 * Versioned migrations. Each entry has a stable string ID and a SQL statement.
 * Migrations are only executed if their ID is not already recorded in the
 * schema_migrations table, so each migration runs exactly once.
 */
const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '001_add_assigned_role',
    sql: `ALTER TABLE tasks ADD COLUMN assigned_role VARCHAR(64) AFTER claimed_by`,
  },
  {
    id: '002_add_max_attempts',
    sql: `ALTER TABLE tasks ADD COLUMN max_attempts INT NOT NULL DEFAULT 1 AFTER assigned_role`,
  },
  {
    id: '003_add_attempt_count',
    sql: `ALTER TABLE tasks ADD COLUMN attempt_count INT NOT NULL DEFAULT 0 AFTER max_attempts`,
  },
  {
    id: '004_add_timeout_seconds',
    sql: `ALTER TABLE tasks ADD COLUMN timeout_seconds INT NULL AFTER attempt_count`,
  },
  {
    id: '005_add_result_summary',
    sql: `ALTER TABLE tasks ADD COLUMN result_summary JSON NULL AFTER result_payload`,
  },
];

export async function initSchema(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    // Ensure base tables (including schema_migrations) exist.
    for (const sql of STATEMENTS) {
      await conn.execute(sql);
    }

    // Fetch already-applied migration IDs.
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM schema_migrations',
    );
    const applied = new Set(rows.map((r) => String(r.id)));

    // Run only unapplied migrations.
    for (const { id, sql } of MIGRATIONS) {
      if (applied.has(id)) continue;
      await conn.execute(sql);
      await conn.execute(
        'INSERT INTO schema_migrations (id, applied_at) VALUES (?, NOW(3))',
        [id],
      );
    }
  } finally {
    conn.release();
  }
}
