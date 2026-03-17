import { spawn } from 'node:child_process';
import { exec } from '@shardworks/shared-types';

// ---------------------------------------------------------------------------
// tq wrappers
// ---------------------------------------------------------------------------

/** Run a `tq` command and return the parsed JSON output. */
export async function runTq<T = unknown>(workDir: string, args: string[]): Promise<T> {
  const { stdout, stderr, exitCode } = await exec('tq', args, workDir);
  if (exitCode !== 0) {
    throw new Error(`tq ${args[0]} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error(`tq ${args[0]} returned non-JSON: ${stdout.trim()}`);
  }
}

export interface ReapResult {
  stale: Array<{ id: string }>;
  released: Array<{ id: string }>;
}

/** Reap stale in_progress tasks and release them back to eligible. */
export async function reapStale(workDir: string, staleAfter: string): Promise<ReapResult> {
  return runTq<ReapResult>(workDir, ['reap', '--stale-after', staleAfter, '--release']);
}

// ---------------------------------------------------------------------------
// Worker spawning
// ---------------------------------------------------------------------------

export interface SpawnedWorker {
  pid: number;
  role: string;
  taskId: string | null;
  startedAt: string;
}

/**
 * Spawn a detached worker process and immediately unref it so the conductor
 * is not blocked on the worker finishing.
 *
 * The worker writes its own logs to data/work-logs/<taskId>.jsonl.
 * The conductor does not track individual worker lifecycle — it relies on
 * the DB (in_progress task count) as the source of truth.
 *
 * When `taskId` is provided the worker is started in conducted mode:
 * `--task-id <taskId>` is passed so the worker claims that specific task
 * rather than racing with other workers for the next available one.
 */
export function spawnWorker(
  workDir: string,
  role: string,
  taskId?: string,
): SpawnedWorker {
  const args: string[] = ['--role', role];
  if (taskId) {
    args.push('--task-id', taskId);
  }

  const child = spawn('worker', args, {
    cwd: workDir,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WORK_DIR: workDir,
    },
  });
  child.unref();

  return {
    pid: child.pid ?? -1,
    role,
    taskId: taskId ?? null,
    startedAt: new Date().toISOString(),
  };
}
