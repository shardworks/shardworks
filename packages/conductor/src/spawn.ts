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
 *
 * When `branch` is provided (and is not 'main'), the worker receives
 * `--branch <branch>` and `DOLT_DATABASE` is set to `shardworks/<branch>`
 * in its environment so all tq library calls and spawned CLI processes
 * are automatically scoped to that branch.
 */
export function spawnWorker(
  workDir: string,
  role: string,
  taskId?: string,
  branch?: string,
): SpawnedWorker {
  const effectiveBranch = branch && branch !== 'main' ? branch : undefined;

  const args: string[] = ['--role', role];
  if (taskId) {
    args.push('--task-id', taskId);
  }
  if (effectiveBranch) {
    args.push('--branch', effectiveBranch);
  }

  const doltDatabase = process.env['DOLT_DATABASE'] ?? 'shardworks';
  const doltDatabaseBase = doltDatabase.split('/')[0] ?? doltDatabase;

  const child = spawn('worker', args, {
    cwd: workDir,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WORK_DIR: workDir,
      WORKER_BRANCH: effectiveBranch ?? 'main',
      // Scope all tq DB operations to the branch by setting the Dolt database
      // connection string.  The worker process (and every tq CLI it spawns as a
      // child) inherits this, so claim / complete / fail / heartbeat etc. all
      // operate on the correct branch without requiring per-call --branch flags.
      DOLT_DATABASE: effectiveBranch
        ? `${doltDatabaseBase}/${effectiveBranch}`
        : doltDatabaseBase,
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
