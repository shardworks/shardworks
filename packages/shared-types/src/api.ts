import type { Task, StatusRollup } from './types.js';

// ---- Inputs ----------------------------------------------------------------

export interface EnqueueInput {
  description: string;
  payload?: unknown;
  /** IDs of existing tasks that must complete before this one becomes eligible. */
  dependencies?: string[];
  parent_id?: string;
  priority?: number;
  created_by: string;
}

/**
 * A task in a batch enqueue request. `client_id` is a temporary identifier
 * used only within the batch to express intra-batch dependencies; it is not
 * stored. Dependencies may reference either `client_id` values within the
 * batch or real task IDs already in the database.
 */
export interface BatchTaskInput extends Omit<EnqueueInput, 'created_by'> {
  client_id: string;
  dependencies?: string[];
}

export interface BatchEnqueueInput {
  tasks: BatchTaskInput[];
  created_by: string;
}

export interface ClaimInput {
  agent_id: string;
}

export interface CompleteInput {
  agent_id: string;
  result_payload?: unknown;
}

export interface FailInput {
  agent_id: string;
  reason: string;
}

// ---- Responses -------------------------------------------------------------

export interface ClaimResult {
  task: Task | null;
}

export interface SubtreeResult {
  tasks: Task[];
  rollup: StatusRollup;
}

/** Maps dependency task ID → result_payload of that dependency. */
export type DepResults = Record<string, unknown>;

export interface ApiError {
  error: string;
  message: string;
}
