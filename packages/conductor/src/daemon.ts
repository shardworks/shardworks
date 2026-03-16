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
import { queryCounts, closePool, queryTasksSince, type TaskCounts } from './db.js';
import { reapStale, spawnWorker, enqueuePlannerTask, type SpawnedWorker } from './spawn.js';
import { readNewSignals } from './signals.js';
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
    state.lastFullPlanAt   = prior.lastFullPlanAt;
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
    batchPlanThreshold: cfg.batchPlanThreshold,
    pollIntervalMs: cfg.pollIntervalMs,
    staleAfter: cfg.staleAfter,
  });
  setPhase('idle');
  await saveState();

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  while (!stopping) {
    await sleep(cfg.pollIntervalMs);
    if (stopping) break;

    state.stats.tickCount++;
    state.lastTickAt = new Date().toISOString();
    log('debug', `Tick #${state.stats.tickCount}`);

    try {
      await tick(cfg, state, log, setPhase);
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
): Promise<void> {
  // ------------------------------------------------------------------
  // 0. Drain the worker signal file — process rate-limit / crash events
  //    emitted by workers since the last tick.
  // ------------------------------------------------------------------
  try {
    const { signals, newOffset } = await readNewSignals(cfg.workDir, state.signalFileOffset);
    state.signalFileOffset = newOffset;
    if (signals.length > 0) {
      log('info', `Processing ${signals.length} worker signal(s)`);
      await processSignals(cfg, state, log, signals);
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

  if (counts.inProgress >= cfg.maxWorkers) {
    setPhase('waiting');
    log('info', `At capacity: ${counts.inProgress}/${cfg.maxWorkers} workers in progress`);
    return;
  }

  const slots = cfg.maxWorkers - counts.inProgress;

  // ------------------------------------------------------------------
  // 3. Full-backlog planning check
  //    Trigger when X+ tasks have been created since the last plan.
  // ------------------------------------------------------------------
  const since = state.lastFullPlanAt ? new Date(state.lastFullPlanAt) : null;
  let tasksSinceLastPlan = 0;
  try {
    tasksSinceLastPlan = await queryTasksSince(since);
  } catch (err) {
    log('warn', 'Could not count tasks since last plan', { error: String(err) });
  }

  const needsFullPlan =
    tasksSinceLastPlan >= cfg.batchPlanThreshold &&
    counts.eligiblePlanner === 0; // avoid creating duplicate planner tasks

  if (needsFullPlan) {
    setPhase('planning');
    log('info', `Full-backlog plan triggered (${tasksSinceLastPlan} tasks since last plan)`);
    try {
      await runFullBacklogPlan(cfg, state, log);
    } catch (err) {
      log('error', 'Full-backlog plan failed', { error: String(err) });
    }
    return;
  }

  // ------------------------------------------------------------------
  // 4. Fill available worker slots
  // ------------------------------------------------------------------

  // Respect rate-limit hold-off from worker signals.
  if (state.rateLimitedUntil) {
    const holdUntil = new Date(state.rateLimitedUntil).getTime();
    if (Date.now() < holdUntil) {
      const resumeAt = new Date(state.rateLimitedUntil).toLocaleTimeString();
      log('info', `Spawning suppressed — rate limited until ${resumeAt}`);
      setPhase('waiting');
      return;
    }
    // Hold-off has expired — clear it.
    state.rateLimitedUntil = null;
  }

  setPhase('spawning');
  let spawnedThisTick = 0;

  for (let i = 0; i < slots; i++) {
    const action = decideNextAction(counts, spawnedThisTick);

    if (!action) {
      state.lastNoWorkAt = new Date().toISOString();
      log('warn', 'No eligible tasks available — waiting for human input', counts);
      await fireAlert(cfg, state, log, 'task_exhaustion',
        'Task queue is empty — no draft, eligible, or planner tasks remain',
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
        if (action === 'planner') counts.eligiblePlanner = Math.max(0, counts.eligiblePlanner - 1);
      }
    } catch (err) {
      log('error', `Failed to spawn ${action} worker`, { error: String(err) });
    }
  }

  setPhase('idle');
}

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

/**
 * Decide what kind of worker to spawn next, given current task counts.
 *
 * Priority order:
 *   1. Planner — if there are planner-assigned eligible tasks (created by
 *      the conductor's full-backlog run or manually).
 *   2. Priority-aware draft vs eligible comparison — when both draft and
 *      eligible tasks exist, compare their highest priorities so that a
 *      high-priority draft is refined before a lower-priority eligible task
 *      is started.  If the top draft priority >= top eligible priority,
 *      spawn a refiner; otherwise spawn an implementer.
 *   3. Implementer — if there are directly implementable eligible tasks.
 *   4. Refiner — if there are draft tasks (including children of eligible
 *      parent containers).  Limited to one per tick to avoid races where
 *      two refiners claim the same draft.
 *   5. null — nothing to do, notify humans.
 *
 * "Implementable" eligible tasks exclude parent containers whose children are
 * all in draft state (not yet refined).  Those parents need a refiner first;
 * an implementer spawned for them would release and exit immediately.
 */
function decideNextAction(
  counts: TaskCounts,
  spawnedThisTick: number,
): 'implementer' | 'refiner' | 'planner' | null {
  if (counts.eligiblePlanner > 0) return 'planner';

  const eligibleWork = counts.eligible - counts.eligiblePlanner;
  // Exclude eligible parents that can't be implemented yet (children still draft).
  const implementableEligible = Math.max(0, eligibleWork - counts.eligibleBlockedByChildren);
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
  action: 'implementer' | 'refiner' | 'planner',
  _counts: TaskCounts,
): Promise<SpawnedWorker | null> {
  let spawned: SpawnedWorker;

  if (action === 'planner') {
    spawned = spawnWorker(cfg.workDir, 'planner');
    log('info', 'Spawned planner worker', { pid: spawned.pid });
  } else if (action === 'refiner') {
    spawned = spawnWorker(cfg.workDir, 'refiner');
    log('info', 'Spawned refiner worker', { pid: spawned.pid });
  } else {
    spawned = spawnWorker(cfg.workDir, 'implementer');
    log('info', 'Spawned implementer worker', { pid: spawned.pid });
  }

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

// ---------------------------------------------------------------------------
// Full-backlog planning
// ---------------------------------------------------------------------------

async function runFullBacklogPlan(
  cfg: ConductorConfig,
  state: ConductorState,
  log: LogFn,
): Promise<void> {
  const description =
    'Full backlog review: deduplicate tasks, organize dependencies, groom priorities, cancel obsolete tasks, split large tasks into subtasks';

  const taskId = await enqueuePlannerTask(cfg.workDir, description, 100);
  log('info', 'Enqueued full-backlog planner task', { taskId });

  const spawned = spawnWorker(cfg.workDir, 'planner', taskId);
  log('info', 'Spawned planner worker for full-backlog review', {
    pid: spawned.pid,
    taskId,
  });

  state.lastFullPlanAt = new Date().toISOString();
  state.stats.fullPlansRun++;
  state.activeWorkers = [
    ...state.activeWorkers.filter((w) => isStillRunning(w.pid)),
    spawned,
  ];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
