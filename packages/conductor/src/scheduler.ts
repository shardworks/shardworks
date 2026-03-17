import type { ConductorConfig } from './config.js';
import type { ConductorState, Phase, LogFn } from './state.js';
import { isAlive } from './state.js';
import { queryCounts, type TaskCounts } from './db.js';
import { reapStale, spawnWorker, type SpawnedWorker } from './spawn.js';
import { readNewSignals, type SpawnRequestSignal } from './signals.js';
import { processSignals, fireAlert } from './alerts.js';

// ---------------------------------------------------------------------------
// Refiner capacity policy
// ---------------------------------------------------------------------------

/** Maximum fraction of maxWorkers that can be refiners simultaneously. */
export const REFINER_MAX_FRACTION = 0.4;

/**
 * Minimum fraction of maxWorkers reserved for refiners when draft tasks exist.
 * Refiners are force-spawned below this floor even if eligible tasks have
 * higher priority.
 */
export const REFINER_RESERVE_FRACTION = 0.1;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * Snapshot of refiner capacity constraints for a single tick.
 * Passed into decideSpawns() so it can make cap/floor-aware decisions.
 */
export interface RefinerState {
  /** Maximum number of simultaneous refiners (40% of maxWorkers). */
  cap: number;
  /** Minimum reserved refiner slots when draft tasks exist (10% of maxWorkers). */
  floor: number;
  /** Number of refiner workers already running at the start of this tick. */
  alreadyRunning: number;
}

// ---------------------------------------------------------------------------
// Scheduler interface
// ---------------------------------------------------------------------------

/**
 * Top-level interface for the conductor's scheduling logic.
 * The daemon loop holds a Scheduler instance and calls tick() each poll interval.
 */
export interface Scheduler {
  /**
   * Orchestrate all sub-steps for a single poll tick:
   * signal drain, reap, assess, decide, spawn.
   */
  tick(
    cfg: ConductorConfig,
    state: ConductorState,
    log: LogFn,
    setPhase: (p: Phase) => void,
    shutdown: (reason: string) => Promise<void>,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// DefaultScheduler
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of Scheduler containing the full scheduling logic.
 * Instantiated once in runDaemon() and injected into the main loop.
 */
export class DefaultScheduler implements Scheduler {
  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------

  /**
   * Run one complete scheduling tick:
   *  0. Drain signal file (rate-limit / crash events + spawn_request signals)
   *  1. Reap stale in_progress tasks
   *  2. Assess capacity (query DB, check rate-limit / at-capacity)
   *  3. Fill available worker slots
   *  4. Handle operator-initiated spawn requests (bypass maxWorkers cap)
   */
  async tick(
    cfg: ConductorConfig,
    state: ConductorState,
    log: LogFn,
    setPhase: (p: Phase) => void,
    shutdown: (reason: string) => Promise<void>,
  ): Promise<void> {
    // ------------------------------------------------------------------
    // 0. Drain the worker signal file
    // ------------------------------------------------------------------
    const pendingSpawnRequests: SpawnRequestSignal[] = [];
    try {
      const { signals, newOffset } = await readNewSignals(cfg.workDir, state.signalFileOffset);
      state.signalFileOffset = newOffset;
      if (signals.length > 0) {
        log('info', `Processing ${signals.length} worker signal(s)`);
        const operationalSignals = signals.filter((s) => {
          if (s.type === 'spawn_request') {
            pendingSpawnRequests.push(s as SpawnRequestSignal);
            return false;
          }
          return true;
        });
        if (operationalSignals.length > 0) {
          const rateLimited = await processSignals(cfg, state, log, operationalSignals);
          if (rateLimited) {
            log('warn', 'Rate limit signal received — shutting down');
            await shutdown('rate_limited');
            return;
          }
        }
      }
    } catch (err) {
      log('warn', 'Failed to read signal file', { error: String(err) });
    }

    // ------------------------------------------------------------------
    // 1. Reap stale in_progress tasks
    // ------------------------------------------------------------------
    setPhase('reaping');
    try {
      const reapResult = await reapStale(cfg.workDir, cfg.staleAfter);
      if (reapResult.released.length > 0) {
        state.stats.tasksReaped += reapResult.released.length;
        log('info', `Reaped ${reapResult.released.length} stale task(s)`, {
          ids: reapResult.released.map((t) => t.id),
        });
      }
    } catch (err) {
      log('warn', 'Reap failed, continuing', { error: String(err) });
    }

    // ------------------------------------------------------------------
    // 2. Assess current capacity
    // ------------------------------------------------------------------
    setPhase('assessing');

    // Load known roles once per tick (used by decideSpawns and autoDetectRole).
    let knownRoles: Set<string>;
    try {
      knownRoles = await this.loadKnownRoles(cfg.workDir);
    } catch {
      knownRoles = new Set(['implementer', 'refiner']);
    }

    // assessCapacity queries the DB and applies rate-limit / atCapacity checks.
    // Returns null if auto-spawning should be skipped this tick; the counts
    // are still needed below for spawn_request handling so we cache them here.
    let cachedCounts: TaskCounts | null = null;
    const spawnableCounts = await this.assessCapacity(cfg, state, log, setPhase);
    if (spawnableCounts) {
      cachedCounts = spawnableCounts;
    }

    // ------------------------------------------------------------------
    // 3. Fill available worker slots (skip when at capacity or rate-limited)
    // ------------------------------------------------------------------
    if (spawnableCounts) {
      const slots = cfg.maxWorkers - spawnableCounts.inProgress;
      setPhase('spawning');

      const refinersAlreadyRunning = state.activeWorkers.filter(
        (w) => w.role === 'refiner' && isAlive(w.pid),
      ).length;

      const refinerState: RefinerState = {
        cap:            Math.max(1, Math.floor(cfg.maxWorkers * REFINER_MAX_FRACTION)),
        floor:          Math.max(1, Math.ceil(cfg.maxWorkers * REFINER_RESERVE_FRACTION)),
        alreadyRunning: refinersAlreadyRunning,
      };

      const roles = this.decideSpawns(slots, spawnableCounts, refinerState, knownRoles);

      if (roles.length === 0) {
        state.lastNoWorkAt = new Date().toISOString();
        log('warn', 'No eligible tasks available — waiting for human input', spawnableCounts);
        await fireAlert(
          cfg, state, log, 'task_exhaustion',
          'Task queue is empty — no draft or eligible tasks remain',
          spawnableCounts as unknown as Record<string, unknown>,
        );
      } else {
        await this.executeSpawns(roles, cfg, state, log, spawnableCounts);
        cachedCounts = spawnableCounts; // executeSpawns mutates counts in-place
      }
    }

    setPhase('idle');

    // ------------------------------------------------------------------
    // 4. Handle operator-initiated spawn requests — bypass maxWorkers cap
    // ------------------------------------------------------------------
    if (pendingSpawnRequests.length > 0) {
      // If we didn't fetch counts in step 2/3, fetch them now for autoDetectRole.
      if (!cachedCounts) {
        try {
          cachedCounts = await queryCounts();
        } catch (err) {
          log('warn', 'Failed to query counts for spawn_request handling', { error: String(err) });
        }
      }

      for (const req of pendingSpawnRequests) {
        const role = req.role ?? (cachedCounts ? this.autoDetectRole(cachedCounts, knownRoles) : null);
        if (!role) {
          log('warn', 'spawn_request: no eligible tasks to spawn for', {
            requested_by: req.requested_by,
            task_id: req.task_id,
          });
          continue;
        }
        log('info', 'spawn_request: spawning worker (operator override — bypassing maxWorkers cap)', {
          role,
          requested_by: req.requested_by,
          task_id: req.task_id ?? null,
        });
        try {
          const counts = cachedCounts!;
          const spawned = await this.doSpawn(cfg, state, log, role, counts);
          if (spawned) {
            state.stats.workersSpawned++;
            counts.inProgress++;
            if (role === 'refiner') {
              counts.draft = Math.max(0, counts.draft - 1);
            } else {
              counts.eligible = Math.max(0, counts.eligible - 1);
              const roleKey = role === 'implementer' ? '' : role;
              if (counts.eligibleByRole[roleKey] !== undefined) {
                counts.eligibleByRole[roleKey] = Math.max(0, counts.eligibleByRole[roleKey] - 1);
              }
            }
          }
        } catch (err) {
          log('error', `spawn_request: failed to spawn ${role} worker`, { error: String(err) });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sub-step methods (public for testability and future composition)
  // -------------------------------------------------------------------------

  /**
   * Query the DB and apply rate-limit / atCapacity checks.
   *
   * Returns the current TaskCounts if auto-spawning should proceed this tick.
   * Returns null if spawning should be skipped (DB error, at capacity, or
   * rate-limited).  Side-effects: logs appropriate messages and updates
   * setPhase / state.rateLimitedUntil.
   */
  async assessCapacity(
    cfg: ConductorConfig,
    state: ConductorState,
    log: LogFn,
    setPhase: (p: Phase) => void,
  ): Promise<TaskCounts | null> {
    let counts: TaskCounts;
    try {
      counts = await queryCounts();
    } catch (err) {
      log('error', 'DB query failed, skipping tick', { error: String(err) });
      setPhase('idle');
      return null;
    }

    log('debug', 'Task counts', counts);

    if (counts.inProgress >= cfg.maxWorkers) {
      setPhase('waiting');
      log('info', `At capacity: ${counts.inProgress}/${cfg.maxWorkers} workers in progress`);
      return null;
    }

    if (state.rateLimitedUntil) {
      const holdUntil = new Date(state.rateLimitedUntil).getTime();
      if (Date.now() < holdUntil) {
        const resumeAt = new Date(state.rateLimitedUntil).toLocaleTimeString();
        log('info', `Spawning suppressed — rate limited until ${resumeAt}`);
        setPhase('waiting');
        return null;
      } else {
        // Hold-off has expired — clear it.
        state.rateLimitedUntil = null;
      }
    }

    return counts;
  }

  /**
   * Pure function that decides the ordered list of roles to spawn given
   * available slots, task counts, and refiner capacity constraints.
   *
   * Simulates optimistic count updates between slots (the same way the live
   * spawn loop does) so that each successive role decision is accurate.
   *
   * Returns an array of role strings, e.g. ["refiner", "implementer"].
   * Array length ≤ slots; may be shorter if no work remains.
   * Returns an empty array when there is nothing to do.
   */
  decideSpawns(
    slots: number,
    counts: TaskCounts,
    refinerState: RefinerState,
    knownRoles: Set<string>,
  ): string[] {
    // Work on a shallow copy so simulated count decrements don't mutate the caller's object.
    const c: TaskCounts = {
      ...counts,
      eligibleByRole: { ...counts.eligibleByRole },
    };

    const roles: string[] = [];
    let refinersThisTick = 0;

    for (let i = 0; i < slots; i++) {
      const action = this.decideNextAction(
        c,
        refinerState.alreadyRunning + refinersThisTick,
        refinerState.cap,
        refinerState.floor,
        knownRoles,
      );

      if (!action) break;

      roles.push(action);

      // Optimistically update the simulated counts so the next iteration sees
      // the correct picture (mirrors the live update in the original spawn loop).
      c.inProgress++;
      if (action === 'refiner') {
        refinersThisTick++;
        c.draft = Math.max(0, c.draft - 1);
      } else {
        c.eligible = Math.max(0, c.eligible - 1);
        const roleKey = action === 'implementer' ? '' : action;
        if (c.eligibleByRole[roleKey] !== undefined) {
          c.eligibleByRole[roleKey] = Math.max(0, c.eligibleByRole[roleKey] - 1);
        }
      }
    }

    return roles;
  }

  /**
   * Spawn a worker for each role in the list, updating state and counts in-place.
   * Mirrors the role→count bookkeeping that was previously inline in tick().
   */
  async executeSpawns(
    roles: string[],
    cfg: ConductorConfig,
    state: ConductorState,
    log: LogFn,
    counts: TaskCounts,
  ): Promise<void> {
    for (const action of roles) {
      try {
        const spawned = await this.doSpawn(cfg, state, log, action, counts);
        if (spawned) {
          state.stats.workersSpawned++;
          counts.inProgress++;
          if (action === 'refiner') {
            counts.draft = Math.max(0, counts.draft - 1);
          } else {
            counts.eligible = Math.max(0, counts.eligible - 1);
            const roleKey = action === 'implementer' ? '' : action;
            if (counts.eligibleByRole[roleKey] !== undefined) {
              counts.eligibleByRole[roleKey] = Math.max(0, counts.eligibleByRole[roleKey] - 1);
            }
          }
        }
      } catch (err) {
        log('error', `Failed to spawn ${action} worker`, { error: String(err) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Load the set of known role IDs from roles.json in workDir.
   * Falls back to a hard-coded default set if the file is missing or unreadable.
   */
  private async loadKnownRoles(workDir: string): Promise<Set<string>> {
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const raw = await readFile(join(workDir, 'roles.json'), 'utf8');
      const config = JSON.parse(raw) as { roles: Array<{ id: string }> };
      return new Set(config.roles.map((r) => r.id));
    } catch {
      // Fallback: built-in roles if roles.json is not readable
      return new Set(['implementer', 'refiner', 'planner', 'tq-reader', 'tq-writer']);
    }
  }

  /**
   * Decide what role of worker to spawn next, given current task counts and
   * refiner capacity constraints.
   *
   * Refiner capacity policy (evaluated first, before priority comparison):
   *   - If refinerCount >= refinerCap  → refiners are at capacity; never spawn one.
   *   - If drafts > 0 && refinerCount < refinerFloor  → reserved floor not met;
   *     force a refiner regardless of eligible task priority.
   *
   * Normal priority order (when floor is satisfied and cap is not reached):
   *   1. Priority-aware draft vs eligible comparison — when both draft and
   *      eligible tasks exist, compare their highest priorities so that a
   *      high-priority draft is refined before a lower-priority eligible task
   *      is started.  If the top draft priority >= top eligible priority,
   *      spawn a refiner; otherwise spawn a worker for the first eligible role.
   *   2. Role-specific eligible tasks — any assigned_role present in roles.json
   *      gets a matching worker spawned.  assigned_role=null tasks spawn an
   *      implementer (backward compat).  Roles not in roles.json (e.g. 'human')
   *      are skipped.
   *   3. Refiner — if there are draft tasks and refinerCount < refinerCap.
   *      Multiple refiners per tick are allowed up to the cap.
   *   4. null — nothing to do, notify humans.
   *
   * @param refinerCount  Total active refiners: already-running + spawned this tick.
   * @param refinerCap    Maximum refiners allowed simultaneously (40% of maxWorkers).
   * @param refinerFloor  Minimum refiner slots reserved when drafts exist (10% of maxWorkers).
   */
  private decideNextAction(
    counts: TaskCounts,
    refinerCount: number,
    refinerCap: number,
    refinerFloor: number,
    knownRoles: Set<string>,
  ): string | null {
    // Cap enforcement: never spawn a refiner if already at or above cap.
    const canRefine = counts.draft > 0 && refinerCount < refinerCap;

    // Build the list of (spawnRole, count) pairs for roles that have eligible
    // tasks and a corresponding worker role definition.
    const spawnableRoles: Array<{ spawnRole: string; count: number }> = [];
    for (const [assignedRole, count] of Object.entries(counts.eligibleByRole)) {
      if (count <= 0) continue;
      if (assignedRole === '') {
        // Unassigned eligible tasks → spawn implementer.
        // Subtract parent containers whose children are all in draft (would be wasted).
        const implementable = Math.max(0, count - counts.eligibleBlockedByChildren);
        if (implementable > 0) {
          spawnableRoles.push({ spawnRole: 'implementer', count: implementable });
        }
      } else if (knownRoles.has(assignedRole)) {
        // Role-specific eligible tasks → spawn a worker with that role.
        spawnableRoles.push({ spawnRole: assignedRole, count });
      }
      // else: assignedRole not in roles.json (e.g. 'human') — no worker to spawn.
    }

    const hasEligibleWork = spawnableRoles.length > 0;

    // Floor reservation: when drafts exist and we're below the reserved floor,
    // force a refiner regardless of eligible task priority to prevent starvation.
    if (canRefine && refinerCount < refinerFloor) {
      return 'refiner';
    }

    // Priority-aware: when both draft and eligible work exist, compare top priorities.
    if (canRefine && hasEligibleWork) {
      return counts.maxDraftPriority >= counts.maxEligiblePriority
        ? 'refiner'
        : spawnableRoles[0].spawnRole;
    }

    if (hasEligibleWork) return spawnableRoles[0].spawnRole;
    if (canRefine) return 'refiner';

    return null;
  }

  /**
   * Auto-detect the role for a spawn_request that didn't specify one.
   * Uses the same priority logic as decideNextAction but ignores the
   * per-tick refiner count limit (since this is an explicit operator request).
   */
  private autoDetectRole(counts: TaskCounts, knownRoles: Set<string>): string | null {
    const spawnableRoles: Array<{ spawnRole: string; count: number }> = [];
    for (const [assignedRole, count] of Object.entries(counts.eligibleByRole)) {
      if (count <= 0) continue;
      if (assignedRole === '') {
        const implementable = Math.max(0, count - counts.eligibleBlockedByChildren);
        if (implementable > 0) spawnableRoles.push({ spawnRole: 'implementer', count: implementable });
      } else if (knownRoles.has(assignedRole)) {
        spawnableRoles.push({ spawnRole: assignedRole, count });
      }
    }

    const hasEligibleWork = spawnableRoles.length > 0;

    if (hasEligibleWork && counts.draft > 0) {
      return counts.maxDraftPriority >= counts.maxEligiblePriority
        ? 'refiner'
        : spawnableRoles[0].spawnRole;
    }
    if (hasEligibleWork) return spawnableRoles[0].spawnRole;
    if (counts.draft > 0) return 'refiner';
    return null;
  }

  /**
   * Spawn a single worker of the given role.
   * Updates state.activeWorkers by pruning dead processes and appending the new one.
   * Returns null if the spawn failed to acquire a valid PID.
   */
  private async doSpawn(
    cfg: ConductorConfig,
    state: ConductorState,
    log: LogFn,
    action: string,
    _counts: TaskCounts,
  ): Promise<SpawnedWorker | null> {
    const spawned = spawnWorker(cfg.workDir, action);
    log('info', `Spawned ${action} worker`, { pid: spawned.pid });

    if (spawned.pid < 0) {
      log('warn', `Failed to get PID for ${action} worker`);
      return null;
    }

    // Track the worker in state (best-effort; the real truth is the DB)
    state.activeWorkers = [
      ...state.activeWorkers.filter((w) => isAlive(w.pid)),
      spawned,
    ];

    return spawned;
  }
}
