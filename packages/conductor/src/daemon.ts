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

      for (let i = 0; i < slots; i++) {
        const action = decideNextAction(counts, spawnedThisTick);

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
            // Optimistically increment so next slot decision is accurate
            counts.inProgress++;
            if (action === 'refiner') counts.draft = Math.max(0, counts.draft - 1);
            if (action === 'implementer') counts.eligible = Math.max(0, counts.eligible - 1);
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
    const role = req.role ?? autoDetectRole(counts);
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
      const spawned = await doSpawn(cfg, state, log, role as 'implementer' | 'refiner', counts);
      if (spawned) {
        state.stats.workersSpawned++;
        counts.inProgress++;
        if (role === 'refiner') counts.draft = Math.max(0, counts.draft - 1);
        if (role === 'implementer') counts.eligible = Math.max(0, counts.eligible - 1);
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
 * Decide what kind of worker to spawn next, given current task counts.
 *
 * Priority order:
 *   1. Priority-aware draft vs eligible comparison — when both draft and
 *      eligible tasks exist, compare their highest priorities so that a
 *      high-priority draft is refined before a lower-priority eligible task
 *      is started.  If the top draft priority >= top eligible priority,
 *      spawn a refiner; otherwise spawn an implementer.
 *   2. Implementer — if there are directly implementable eligible tasks.
 *   3. Refiner — if there are draft tasks (including children of eligible
 *      parent containers).  Limited to one per tick to avoid races where
 *      two refiners claim the same draft.
 *   4. null — nothing to do, notify humans.
 *
 * "Implementable" eligible tasks exclude parent containers whose children are
 * all in draft state (not yet refined).  Those parents need a refiner first;
 * an implementer spawned for them would release and exit immediately.
 */
function decideNextAction(
  counts: TaskCounts,
  spawnedThisTick: number,
): 'implementer' | 'refiner' | null {
  const implementableEligible = Math.max(0, counts.eligible - counts.eligibleBlockedByChildren);
  const canRefine = counts.draft > 0 && spawnedThisTick === 0;

  // Both directly-implementable and draft tasks exist — pick based on top priority
  if (canRefine && implementableEligible > 0) {
    return counts.maxDraftPriority >= counts.maxEligiblePriority ? 'refiner' : 'implementer';
  }

  if (implementableEligible > 0) return 'implementer';
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
  action: 'implementer' | 'refiner',
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
function autoDetectRole(counts: TaskCounts): 'implementer' | 'refiner' | null {
  const implementableEligible = Math.max(0, counts.eligible - counts.eligibleBlockedByChildren);
  if (implementableEligible > 0 && counts.draft > 0) {
    return counts.maxDraftPriority >= counts.maxEligiblePriority ? 'refiner' : 'implementer';
  }
  if (implementableEligible > 0) return 'implementer';
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
