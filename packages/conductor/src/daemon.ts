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
import { closePool } from './db.js';
import { signalFilePath } from './signals.js';
import { createDefaultManagers, type Manager, type TickContext } from './managers/index.js';

// ---------------------------------------------------------------------------
// Daemon entry point
// ---------------------------------------------------------------------------

/**
 * Run the conductor daemon loop.  Never returns (until SIGTERM/SIGINT).
 * Writes state and logs to data/ within workDir.
 *
 * The daemon orchestrates a pipeline of Manager instances that each own a
 * single operational concern (signal draining, reaping, spawning, cleanup).
 * See `managers/index.ts` for the default pipeline.
 */
export async function runDaemon(
  cfg: ConductorConfig,
  managers?: Manager[],
): Promise<void> {
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
  // Manager pipeline
  // -------------------------------------------------------------------------

  const pipeline = managers ?? createDefaultManagers();

  // Record manager names in state for `conductor status`
  state.managers = pipeline.map((m) => m.name);

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  log('info', 'Conductor daemon starting', {
    maxWorkers: cfg.maxWorkers,
    pollIntervalMs: cfg.pollIntervalMs,
    staleAfter: cfg.staleAfter,
    managers: pipeline.map((m) => m.name),
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
      await runManagers(pipeline, cfg, state, log, setPhase, shutdown);
    } catch (err) {
      log('error', 'Tick failed with unexpected error', { error: String(err) });
      setPhase('idle');
    }

    await saveState();
  }
}

// ---------------------------------------------------------------------------
// Manager orchestration
// ---------------------------------------------------------------------------

/**
 * Execute all managers in pipeline order for a single tick.
 *
 * Each manager receives a shared TickContext. If a manager returns
 * `{ abort: true }`, remaining managers are skipped for this tick.
 * If a manager throws, the error is logged and the pipeline continues
 * with the next manager (fault isolation).
 */
async function runManagers(
  managers: Manager[],
  cfg: ConductorConfig,
  state: ConductorState,
  log: LogFn,
  setPhase: (p: Phase) => void,
  shutdown: (reason: string) => Promise<void>,
): Promise<void> {
  const ctx: TickContext = {
    cfg,
    state,
    log,
    setPhase,
    shutdown,
    shared: {},
  };

  for (const manager of managers) {
    try {
      const result = await manager.run(ctx);
      if (result.abort) {
        log('info', `Manager "${manager.name}" requested tick abort`, result.summary);
        break;
      }
    } catch (err) {
      log('error', `Manager "${manager.name}" failed`, { error: String(err) });
      // Continue with next manager — fault isolation
    }
  }

  setPhase('idle');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Sleep for `ms` milliseconds, but wake up early if the signals file changes.
 * Uses fs.watch for zero-cost idle waiting.
 */
function interruptibleSleep(ms: number, signalFile: string): Promise<void> {
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
      watcher = watch(signalFile, finish);
    } catch {
      // Signals file doesn't exist yet — fall back to plain timer.
    }
  });
}
