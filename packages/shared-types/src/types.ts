/** A JSON-serializable value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TaskStatus =
  | 'draft'
  | 'pending'
  | 'eligible'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface Task {
  id: string;
  description: string;
  payload: unknown;
  status: TaskStatus;
  parent_id: string | null;
  priority: number;
  result_payload: JsonValue | null;
  result_summary: JsonValue | null;
  created_by: string;
  claimed_by: string | null;
  /** Optional role that must match the claiming worker's role. Null means any role. */
  assigned_role: string | null;
  /** Maximum number of attempts before the task is permanently failed. */
  max_attempts: number;
  /** Number of times the task has been attempted (failed/crashed). */
  attempt_count: number;
  /** Optional per-task timeout in seconds; null means no timeout. */
  timeout_seconds: number | null;
  created_at: Date;
  eligible_at: Date | null;
  claimed_at: Date | null;
  completed_at: Date | null;
  /** IDs of tasks that must complete before this task becomes eligible. */
  dependencies: string[];
}

/** Annotated (non-scheduling) relationship types between tasks. */
export type RelationshipType =
  | 'relates_to'
  | 'duplicates'
  | 'supersedes'
  | 'replies_to'
  | 'spawned_from';

export interface TaskRelationship {
  from_task_id: string;
  to_task_id: string;
  relationship_type: RelationshipType;
  created_by: string;
  created_at: Date;
}

export interface StatusRollup {
  draft: number;
  pending: number;
  eligible: number;
  in_progress: number;
  completed: number;
  failed: number;
  cancelled: number;
  blocked: number;
  total: number;
}
