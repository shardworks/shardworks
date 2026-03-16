import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

export function dataDir(workDir: string): string {
  return join(workDir, 'data');
}

export function pidPath(workDir: string): string {
  return join(dataDir(workDir), 'conductor.pid');
}

export function statePath(workDir: string): string {
  return join(dataDir(workDir), 'conductor-state.json');
}

export function logPath(workDir: string): string {
  return join(dataDir(workDir), 'conductor.jsonl');
}

// ---------------------------------------------------------------------------
// PID management
// ---------------------------------------------------------------------------

export async function writePid(workDir: string, pid: number): Promise<void> {
  await mkdir(dataDir(workDir), { recursive: true });
  await writeFile(pidPath(workDir), String(pid), 'utf8');
}

export async function readPid(workDir: string): Promise<number | null> {
  try {
    const raw = await readFile(pidPath(workDir), 'utf8');
    const n = parseInt(raw.trim(), 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

export async function clearPid(workDir: string): Promise<void> {
  try {
    await unlink(pidPath(workDir));
  } catch {
    // ignore if already gone
  }
}

/** Returns true if a process with the given PID is currently alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Conductor state
// ---------------------------------------------------------------------------

export type Phase =
  | 'starting'
  | 'idle'
  | 'reaping'
  | 'assessing'
  | 'planning'
  | 'spawning'
  | 'waiting'
  | 'stopping';

export interface ActiveWorker {
  pid: number;
  taskId: string | null;
  role: string;
  startedAt: string;
}

export interface ConductorStats {
  tasksReaped: number;
  workersSpawned: number;
  fullPlansRun: number;
  tickCount: number;
  startedAt: string;
}

export type AlertType = 'rate_limited' | 'task_exhaustion' | 'crashed' | 'merge_failed';

export interface ConductorState {
  phase: Phase;
  lastTickAt: string | null;
  lastFullPlanAt: string | null;
  lastNoWorkAt: string | null;
  /**
   * ISO timestamp until which spawning should be suppressed due to a
   * rate-limit signal from a worker.  null means no active rate-limit hold.
   */
  rateLimitedUntil: string | null;
  /** Byte offset into data/conductor-signals.jsonl — tracks consumption progress. */
  signalFileOffset: number;
  /** ISO timestamps of when each alert type was last fired, for cooldown tracking. */
  lastAlertAt: Partial<Record<AlertType, string>>;
  activeWorkers: ActiveWorker[];
  stats: ConductorStats;
}

/** Structured logger function passed through the daemon tick stack. */
export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string, data?: unknown) => void;

export function initialState(): ConductorState {
  return {
    phase: 'starting',
    lastTickAt: null,
    lastFullPlanAt: null,
    lastNoWorkAt: null,
    rateLimitedUntil: null,
    signalFileOffset: 0,
    lastAlertAt: {},
    activeWorkers: [],
    stats: {
      tasksReaped: 0,
      workersSpawned: 0,
      fullPlansRun: 0,
      tickCount: 0,
      startedAt: new Date().toISOString(),
    },
  };
}

export async function writeState(workDir: string, state: ConductorState): Promise<void> {
  await mkdir(dataDir(workDir), { recursive: true });
  const tmp = statePath(workDir) + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  // Atomic rename
  const { rename } = await import('node:fs/promises');
  await rename(tmp, statePath(workDir));
}

export async function readState(workDir: string): Promise<ConductorState | null> {
  try {
    const raw = await readFile(statePath(workDir), 'utf8');
    return JSON.parse(raw) as ConductorState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  phase: Phase;
  msg: string;
  data?: unknown;
}

/**
 * Append a structured log entry to the conductor JSONL log.
 * Uses synchronous I/O so it is safe to call from signal handlers.
 */
export function appendLog(
  workDir: string,
  level: LogLevel,
  phase: Phase,
  msg: string,
  data?: unknown,
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    phase,
    msg,
    ...(data !== undefined ? { data } : {}),
  };
  try {
    // Ensure directory exists (best-effort sync)
    const dir = dataDir(workDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath(workDir), JSON.stringify(entry) + '\n');
  } catch {
    // Last-resort: write to stderr so it's not silently lost
    process.stderr.write(`[conductor] ${level.toUpperCase()} ${msg}\n`);
  }
}
