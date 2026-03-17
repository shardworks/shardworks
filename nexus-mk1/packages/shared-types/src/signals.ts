export interface RateLimitSignal {
  type: 'rate_limited';
  ts: string;
  task_id: string;
  agent_id: string;
  session_id: string | null;
  retry_after: string | null;
  cost_usd: number;
}

export interface CrashedSignal {
  type: 'crashed';
  ts: string;
  task_id: string;
  agent_id: string;
  session_id: string | null;
  exit_code: number;
  cost_usd: number;
}

export interface MergeFailedSignal {
  type: 'merge_failed';
  ts: string;
  task_id: string;
  agent_id: string;
  reason: string;
  msg: string;
}

export interface SpawnRequestSignal {
  type: 'spawn_request';
  ts: string;
  /** Optional hint — the task the caller wants processed next. */
  task_id?: string;
  /** Optional role override: 'refiner' | 'implementer' | 'planner'. Auto-detected when omitted. */
  role?: string;
  /** Who requested the spawn (e.g. 'cli', an agent ID, 'vscode'). */
  requested_by: string;
}

export type WorkerSignal = RateLimitSignal | CrashedSignal | MergeFailedSignal | SpawnRequestSignal;
