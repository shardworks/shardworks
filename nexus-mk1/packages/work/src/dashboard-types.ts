import type { RowDataPacket } from 'mysql2/promise';
import type { TaskDbRow } from '@shardworks/shared-types';

// ---------------------------------------------------------------------------
// Shared dashboard types — no runtime logic, types only
// ---------------------------------------------------------------------------

/**
 * TaskRow extends the canonical TaskDbRow schema (from @shardworks/shared-types)
 * with the mysql2 RowDataPacket marker so that typed execute<TaskRow[]>() calls
 * work correctly.
 */
export interface TaskRow extends RowDataPacket, TaskDbRow {}

export interface StatusCounts {
  pending: number;
  eligible: number;
  in_progress: number;
  completed: number;
  failed: number;
  draft: number;
  total: number;
}

export interface ActiveWorker {
  agentId: string;
  taskId: string;
  description: string;
  claimedAt: Date | null;
  role: string | null;
}

export interface TaskMeta {
  taskId: string;
  status: string;
  claimedBy: string | null;
}

export interface TaskTreeResult {
  lines: string[];
  meta: TaskMeta[];
  hiddenCount: number;
}
