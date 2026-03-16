import { watch } from 'node:fs';
import type { ConductorConfig } from './config.js';
import {
  initialState,
  readState,
  writeState,
  appendLog,
  clearPid,
  type ConductorState,
  type Phase,
  type LogFn,
} from './state.js';
import { queryCounts, closePool, type TaskCounts } from './db.js';
import { reapStale, spawnWorker, type SpawnedWorker } from './spawn.js';
import { readNewSignals, signalFilePath, type SpawnRequestSignal } from './signals.js';
import { processSignals, fireAlert } from './alerts.js';

// ---------------------------------------------------------------------------
// Refiner capacity policy
// ---------------------------------------------------------------------------

/** Maximum fraction of maxWorkers that can be refiners simultaneously. */
const REFINER_MAX_FRACTION = 0.4;

/**
 * Minimum fraction of maxWorkers reserved for refiners when draft tasks exist.
 * Refiners are force-spawned below this floor even if eligible tasks have
 * higher priority.
 */
const REFINER_RESERVE_FRACTION = 0.1;

// ---------------------------------------------------------------------------
// Daemon entry point
// ---------------------------------------------------------------------------

/**
 * Run the conductor daemon loop.  Never returns (until SIGTERM/SIGINT).
 * Writes state and logs to data/ within workDir.
 */
export async function runDaemon(cfg: ConductorConfig): Promise<void> {
  const state = initialState();

  // Restore persistent fields from the previous run's state file so we
  // don't replay old signals, re-fire cooldown'd alerts, etc.
  const prior = await readState(cfg.workDir);
  if (prior) {
    state.signalFileOffset = prior.signalFileOffset;
    state.lastAlertAt      = prior.lastAlertAt;
    state.rateLimitedUntil = prior.rateLimitedUntil ?? null;
    // activeWorkers and stats intentionally reset — stale PIDs are unreliable.
  }

  function log(
    level: 'info' | 'warn' | 'error' | 'debug',
    msg: string,
    data?: unknown,
  ): void {
    appendLog(cfg.workDir, level, state.phase, msg, data);
  }

  // Serialise all writes through a single promise chain so that concurrent
  // fire-and-forget saves from setPhase() never race with awaited saves on
  // the shared .tmp file (which would produce ENOENT on rename).
  let saveQueue: Promise<void> = Promise.resolve();

  async function saveState(): Promise<void> {
    saveQueue = saveQueue.then(async () => {
      try {
        await writeState(cfg.workDir, state);
      } catch (err) {
        log('error', 'Failed to write state file', { error: String(err) });
      }
    });
    return saveQueue;
  }

  function setPhase(phase: Phase): void {
    state.phase = phase;
    // Fire-and-forget state flush — serialised through saveQueue
    saveState().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  let stopping = false;

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    setPhase('stopping');
    log('info', `Received ${signal}, shutting down gracefully`);
    await saveState();
    await closePool();
    await clearPid(cfg.workDir);
    process.exit(0);
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  log('info', 'Conductor daemon starting', {
    maxWorkers: cfg.maxWorkers,
    pollIntervalMs: cfg.pollIntervalMs,
    staleAfter: cfg.staleAfter,
  });
  setPhase('idle');
  await saveState();

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  while (!stopping) {
    await interruptibleSleep(cfg.pollIntervalMs, signalFilePath(cfg.workDir));
    if (stopping) break;

    state.stats.tickCount++;
    state.lastTickAt = new Date().toISOString();
    log('debug', `Tick #${state.stats.tickCount}`);

    try {
      await tick(cfg, state, log, setPhase, shutdown);
    } catch (err) {
      log('error', 'Tick failed with unexpected error', { error: String(err) });
      setPhase('idle');
    }

    await saveState();
  }
}

// ---------------------------------------------------------------------------
// Single tick
// ---------------------------------------------------------------------------


async function tick(
  cfg: ConductorConfig,
  state: ConductorState,
  log: LogFn,
  setPhase: (p: Phase) => void,
  shutdown: (reason: string) => Promise<void>,
): Promise<void> {
  // ------------------------------------------------------------------
  // 0. Drain the worker signal file — process rate-limit / crash events
  //    emitted by workers since the last tick, and handle any pending
  //    spawn_request signals.
  // ------------------------------------------------------------------
  const pendingSpawnRequests: SpawnRequestSignal[] = [];
  try {
    const { signals, newOffset } = await readNewSignals(cfg.workDir, state.signalFileOffset);
    state.signalFileOffset = newOffset;
    if (signals.length > 0) {
      log('info', `Processing ${signals.length} worker signal(s)`);
      // Separate spawn_request signals from operational signals so we can
      // handle them after the normal flow (bypassing maxWorkers cap).
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
  let counts: TaskCounts;
  try {
    counts = await queryCounts();
  } catch (err) {
    log('error', 'DB query failed, skipping tick', { error: String(err) });
    setPhase('idle');
    return;
  }

  log('debug', 'Task counts', counts);

  const atCapacity = counts.inProgress >= cfg.maxWorkers;

  if (atCapacity) {
    setPhase('waiting');
    log('info', `At capacity: ${counts.inProgress}/${cfg.maxWorkers} workers in progress`);
  }

  // ------------------------------------------------------------------
  // 3. Fill available worker slots (skip when at capacity or rate limited)
  // ------------------------------------------------------------------

  // Load known roles once per tick (used by decideNextAction and autoDetectRole).
  let knownRoles: Set<string>;
  try {
    knownRoles = await loadKnownRoles(cfg.workDir);
  } catch {
    knownRoles = new Set(['implementer', 'refiner']);
  }

  if (!atCapacity) {
    // Respect rate-limit hold-off from worker signals.
    let rateLimitActive = false;
    if (state.rateLimitedUntil) {
      const holdUntil = new Date(state.rateLimitedUntil).getTime();
      if (Date.now() < holdUntil) {
        const resumeAt = new Date(state.rateLimitedUntil).toLocaleTimeString();
        log('info', `Spawning suppressed — rate limited until ${resumeAt}`);
        setPhase('waiting');
        rateLimitActive = true;
      } else {
        // Hold-off has expired — clear it.
        state.rateLimitedUntil = null;
      }
    }

    if (!rateLimitActive) {
      const slots = cfg.maxWorkers - counts.inProgress;
      setPhase('spawning');
      let spawnedThisTick = 0;

      // Refiner capacity policy: cap at 40% of maxWorkers, reserve floor at 10%.
      // Math.max(1, ...) ensures at least one refiner slot on any maxWorkers value.
      const refinerCap   = Math.max(1, Math.floor(cfg.maxWorkers * REFINER_MAX_FRACTION));
      const refinerFloor = Math.max(1, Math.ceil(cfg.maxWorkers * REFINER_RESERVE_FRACTION));
      // Count refiners already running (tracked in state from previous ticks).
      const refinersAlreadyRunning = state.activeWorkers.filter(
        (w) => w.role === 'refiner' && isStillRunning(w.pid),
      ).length;
      let refinersThisTick = 0;

      for (let i = 0; i < slots; i++) {
        const action = decideNextAction(
          counts,
          refinersAlreadyRunning + refinersThisTick,
          refinerCap,
          refinerFloor,
          knownRoles,
        );

        if (!action) {
          state.lastNoWorkAt = new Date().toISOString();
          log('warn', 'No eligible tasks available — waiting for human input', counts);
          await fireAlert(cfg, state, log, 'task_exhaustion',
            'Task queue is empty — no draft or eligible tasks remain',
            counts as unknown as Record<string, unknown>,
          );
          break;
        }

        try {
          const spawned = await doSpawn(cfg, state, log, action, counts);
          if (spawned) {
            state.stats.workersSpawned++;
            spawnedThisTick++;
            // Optimistically update counts so next slot decision is accurate.
            counts.inProgress++;
            if (action === 'refiner') {
              refinersThisTick++;
              counts.draft = Math.max(0, counts.draft - 1);
            } else {
              counts.eligible = Math.max(0, counts.eligible - 1);
              // Decrement the role-specific bucket too ('' for implementer/unassigned).
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
  }

  setPhase('idle');

  // ------------------------------------------------------------------
  // 4. Handle operator-initiated spawn requests — bypass maxWorkers cap
  // ------------------------------------------------------------------
  for (const req of pendingSpawnRequests) {
    const role = req.role ?? autoDetectRole(counts, knownRoles);
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
      const spawned = await doSpawn(cfg, state, log, role, counts);
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

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

/**
 * Load the set of known role IDs from roles.json in workDir.
 * Falls back to a hard-coded default set if the file is missing or unreadable.
 */
async function loadKnownRoles(workDir: string): Promise<Set<string>> {
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
 * "Implementable" unassigned eligible tasks exclude parent containers whose
 * children are all in draft state (not yet refined).
 *
 * @param refinerCount  Total active refiners: already-running + spawned this tick.
 * @param refinerCap    Maximum refiners allowed simultaneously (40% of maxWorkers).
 * @param refinerFloor  Minimum refiner slots reserved when drafts exist (10% of maxWorkers).
 */
function decideNextAction(
  counts: TaskCounts,
  refinerCount: number,
  refinerCap: number,
  refinerFloor: number,
  knownRoles: Set<string>,
): string | null {
  // Cap enforcement: never spawn a refiner if already at or above cap.
  const canRefine = counts.draft > 0 && refinerCount < refinerCap;

  // Build the list of (spawnRole, count) pairs for roles that have eligible tasks
  // and a corresponding worker role definition.
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

// ---------------------------------------------------------------------------
// Worker spawning
// ---------------------------------------------------------------------------

async function doSpawn(
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
    ...state.activeWorkers.filter((w) => isStillRunning(w.pid)),
    spawned,
  ];

  return spawned;
}

/**
 * Auto-detect the role for a spawn_request that didn't specify one.
 * Uses the same priority logic as decideNextAction but ignores the
 * spawnedThisTick limit (since this is an explicit operator request).
 */
function autoDetectRole(counts: TaskCounts, knownRoles: Set<string>): string | null {
  // Same spawnable-role collection as decideNextAction
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Sleep for `ms` milliseconds, but wake up early if the signals file changes.
 * Uses fs.watch for zero-cost idle waiting.
 */
function interruptibleSleep(ms: number, signalFilePath: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      watcher?.close();
      resolve();
    };

    const timer = setTimeout(finish, ms);

    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(signalFilePath, finish);
    } catch {
      // Signals file doesn't exist yet — fall back to plain timer.
    }
  });
}

function isStillRunning(pid: number): boolean {
  if (pid < 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
