import type { ConductorConfig } from '../config.js';
import type { ConductorState, Phase, LogFn } from '../state.js';

// ---------------------------------------------------------------------------
// Manager interface
// ---------------------------------------------------------------------------

/**
 * Context passed to each manager on every tick.
 * Provides access to config, mutable state, logging, phase control, and
 * a shutdown hook.  Managers may store additional per-tick data in `shared`.
 */
export interface TickContext {
  cfg: ConductorConfig;
  state: ConductorState;
  log: LogFn;
  setPhase: (p: Phase) => void;
  shutdown: (reason: string) => Promise<void>;
  /**
   * A per-tick key/value bag for managers to communicate within a single tick.
   * For example the signal-drain step stores pending spawn requests here for
   * the spawner to pick up.
   */
  shared: Record<string, unknown>;
}

/**
 * A Manager encapsulates a single operational concern of the conductor.
 *
 * Managers are executed sequentially in a deterministic order during each tick.
 * They must not conflict — each owns a clear slice of responsibility.
 *
 * Design constraints:
 *   - Managers are plain objects with a `run` method (no subprocesses).
 *   - They receive a shared TickContext and may read/write state and shared data.
 *   - A manager may signal "abort the rest of this tick" by returning
 *     `{ abort: true }`.  This is used e.g. when a rate-limit signal triggers
 *     a shutdown.
 *   - Managers must be safe to skip (the conductor stays functional if a
 *     manager throws — the tick continues with the next manager).
 */
export interface Manager {
  /** Human-readable name shown in `conductor status`. */
  readonly name: string;

  /**
   * Execute this manager's responsibilities for one tick.
   *
   * @returns An optional result object.  If `abort` is true the conductor
   *          skips all remaining managers for this tick.
   */
  run(ctx: TickContext): Promise<ManagerResult>;
}

export interface ManagerResult {
  /** If true, skip remaining managers this tick (e.g. shutdown requested). */
  abort?: boolean;
  /** Optional structured summary for logging / status display. */
  summary?: Record<string, unknown>;
}
