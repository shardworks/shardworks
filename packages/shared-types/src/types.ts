export type TaskStatus =
  | 'draft'
  | 'pending'
  | 'eligible'
  | 'in_progress'
  | 'completed'
  | 'failed';

export interface Task {
  id: string;
  description: string;
  payload: unknown;
  status: TaskStatus;
  parent_id: string | null;
  priority: number;
  result_payload: unknown | null;
  created_by: string;
  claimed_by: string | null;
  /** Optional role that must match the claiming worker's role. Null means any role. */
  assigned_role: string | null;
  created_at: Date;
  eligible_at: Date | null;
  claimed_at: Date | null;
  completed_at: Date | null;
  /** IDs of tasks that must complete before this task becomes eligible. */
  dependencies: string[];
}

export interface StatusRollup {
  draft: number;
  pending: number;
  eligible: number;
  in_progress: number;
  completed: number;
  failed: number;
  total: number;
}
