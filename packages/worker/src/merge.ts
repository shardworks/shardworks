import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Exec helper
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function exec(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

// ---------------------------------------------------------------------------
// Task metadata helper
// ---------------------------------------------------------------------------

interface TaskMeta {
  description: string;
  claimedAt: string | null;
  completedAt: string | null;
}

/**
 * Fetch task metadata from the task queue via `tq show`.
 * Returns a minimal TaskMeta with fallback values on failure.
 */
async function fetchTaskMeta(taskId: string, workDir: string): Promise<TaskMeta> {
  try {
    const { stdout, exitCode } = await exec('tq', ['show', taskId], workDir);
    if (exitCode !== 0) return { description: taskId, claimedAt: null, completedAt: null };
    const task = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return {
      description: typeof task.description === 'string' ? task.description : taskId,
      claimedAt:   typeof task.claimed_at   === 'string' ? task.claimed_at   : null,
      completedAt: typeof task.completed_at === 'string' ? task.completed_at : null,
    };
  } catch {
    return { description: taskId, claimedAt: null, completedAt: null };
  }
}

/**
 * Format a duration in milliseconds as a human-readable string, e.g. "2h 3m 14s".
 */
function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSecs = Math.round(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type MergeReason =
  | 'merged'        // Changes successfully merged and pushed
  | 'no-branch'     // Worktree branch does not exist (no code changes made)
  | 'no-commits'    // Branch exists but has no new commits vs main
  | 'conflict'      // Merge conflict — needs manual resolution
  | 'push-failed'   // Merge succeeded locally but push failed after retries
  | 'error';        // Unexpected error

export interface MergeResult {
  ok: boolean;
  reason: MergeReason;
  msg: string;
  commitSha?: string;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Merge the task's worktree branch (`worktree-<taskId>`) back into `main`
 * and push to origin.  Called by the worker after a successful task completion.
 *
 * Strategy: `git merge --no-ff` to preserve branch history with a clear merge
 * commit.  On push failure (concurrent worker pushed first), pull --rebase and
 * retry once.
 *
 * Cleans up the worktree directory and local branch on success.
 *
 * @param agentId - The agent ID that completed the task (used in commit body).
 */
export async function mergeWorktreeToMain(
  taskId: string,
  workDir: string,
  agentId?: string,
): Promise<MergeResult> {
  const branchName  = `worktree-${taskId}`;
  const worktreePath = join(workDir, '.claude', 'worktrees', taskId);

  // ------------------------------------------------------------------
  // 1. Check the branch exists
  // ------------------------------------------------------------------
  const verifyBranch = await exec('git', ['rev-parse', '--verify', branchName], workDir);
  if (verifyBranch.exitCode !== 0) {
    // No branch — agent made no commits. Still remove the worktree directory if
    // one was created (the branch won't exist, so pass undefined to skip branch deletion).
    await cleanupWorktree(workDir, worktreePath, undefined);
    return {
      ok: true,
      reason: 'no-branch',
      msg: `Branch ${branchName} does not exist — no code changes to merge`,
    };
  }

  // ------------------------------------------------------------------
  // 2. Fetch origin/main to check freshness
  // ------------------------------------------------------------------
  await exec('git', ['fetch', 'origin', 'main'], workDir);

  // ------------------------------------------------------------------
  // 3. Count how many commits the branch has ahead of main
  // ------------------------------------------------------------------
  const { stdout: aheadOut } = await exec(
    'git', ['rev-list', '--count', `main..${branchName}`], workDir,
  );
  const aheadCount = parseInt(aheadOut.trim(), 10);

  if (isNaN(aheadCount) || aheadCount === 0) {
    await cleanupWorktree(workDir, worktreePath, branchName);
    return {
      ok: true,
      reason: 'no-commits',
      msg: `Branch ${branchName} has no new commits — nothing to merge`,
    };
  }

  // ------------------------------------------------------------------
  // 4. Build commit message then merge (--no-ff for clear history)
  // ------------------------------------------------------------------
  const meta = await fetchTaskMeta(taskId, workDir);
  const completedAt = meta.completedAt ?? new Date().toISOString();

  // Title: truncate description to 72 chars + task ID suffix
  const titleDesc = meta.description.length > 72
    ? meta.description.slice(0, 72)
    : meta.description;
  const mergeTitle = `${titleDesc} [${taskId}]`;

  // Body: agent/timing metadata
  let durationStr = 'unknown';
  if (meta.claimedAt) {
    const claimedMs  = new Date(meta.claimedAt).getTime();
    const completedMs = new Date(completedAt).getTime();
    if (!isNaN(claimedMs) && !isNaN(completedMs)) {
      durationStr = formatDuration(completedMs - claimedMs);
    }
  }
  const mergeBody = [
    `Task: ${taskId}`,
    `Agent: ${agentId ?? 'unknown'}`,
    `Status: completed`,
    `Claimed: ${meta.claimedAt ?? 'unknown'}`,
    `Completed: ${completedAt}`,
    `Duration: ${durationStr}`,
  ].join('\n');

  const buildMergeArgs = (branch: string) => [
    'merge', branch, '--no-ff', '-m', mergeTitle, '-m', mergeBody,
  ];

  let mergeResult = await exec('git', buildMergeArgs(branchName), workDir);

  if (mergeResult.exitCode !== 0) {
    // If the failure is because untracked files would be overwritten, remove
    // them and retry once — they would have been replaced by the merge anyway.
    const staleFiles = parseUntrackedOverwriteFiles(mergeResult.stderr);
    if (staleFiles.length > 0) {
      for (const f of staleFiles) {
        try { rmSync(join(workDir, f)); } catch { /* ignore if already gone */ }
      }
      mergeResult = await exec('git', buildMergeArgs(branchName), workDir);
    }
  }

  if (mergeResult.exitCode !== 0) {
    // Abort to leave the repo clean
    await exec('git', ['merge', '--abort'], workDir);
    return {
      ok: false,
      reason: 'conflict',
      msg: `Merge conflict merging ${branchName} into main: ${mergeResult.stderr.trim()}`,
    };
  }

  // ------------------------------------------------------------------
  // 5. Push to origin/main (with one retry on concurrent-push failure)
  // ------------------------------------------------------------------
  const pushed = await pushWithRetry(workDir);
  if (!pushed.ok) {
    // Roll back the local merge commit so HEAD stays clean
    await exec('git', ['reset', '--hard', 'ORIG_HEAD'], workDir);
    return {
      ok: false,
      reason: 'push-failed',
      msg: `Failed to push main after merge: ${pushed.msg}`,
    };
  }

  // ------------------------------------------------------------------
  // 6. Record the resulting commit SHA
  // ------------------------------------------------------------------
  const { stdout: shaOut } = await exec('git', ['rev-parse', 'HEAD'], workDir);
  const commitSha = shaOut.trim();

  // ------------------------------------------------------------------
  // 7. Clean up the worktree and branch
  // ------------------------------------------------------------------
  await cleanupWorktree(workDir, worktreePath, branchName);

  return { ok: true, reason: 'merged', msg: `Merged ${aheadCount} commit(s)`, commitSha };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pushWithRetry(workDir: string): Promise<{ ok: boolean; msg: string }> {
  const push1 = await exec('git', ['push', 'origin', 'main'], workDir);
  if (push1.exitCode === 0) return { ok: true, msg: '' };

  // Another worker may have pushed concurrently — pull --rebase and retry
  const rebase = await exec('git', ['pull', '--rebase', 'origin', 'main'], workDir);
  if (rebase.exitCode !== 0) {
    return { ok: false, msg: `pull --rebase failed: ${rebase.stderr.trim()}` };
  }

  const push2 = await exec('git', ['push', 'origin', 'main'], workDir);
  if (push2.exitCode === 0) return { ok: true, msg: '' };

  return { ok: false, msg: push2.stderr.trim() };
}

/**
 * Parse git's "untracked working tree files would be overwritten by merge"
 * error output and return the list of file paths that need to be removed.
 */
function parseUntrackedOverwriteFiles(stderr: string): string[] {
  const files: string[] = [];
  let capturing = false;
  for (const line of stderr.split('\n')) {
    if (line.includes('untracked working tree files would be overwritten')) {
      capturing = true;
      continue;
    }
    if (capturing) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Please') || trimmed.startsWith('Aborting') || trimmed.startsWith('Merge')) {
        capturing = false;
      } else {
        files.push(trimmed);
      }
    }
  }
  return files;
}

async function cleanupWorktree(
  workDir: string,
  worktreePath: string,
  branchName: string | undefined,
): Promise<void> {
  // Remove the worktree directory if it still exists
  if (existsSync(worktreePath)) {
    await exec('git', ['worktree', 'remove', '--force', worktreePath], workDir);
  }
  // Delete the local branch (skip if no branch was created, e.g. no-branch case)
  if (branchName) {
    await exec('git', ['branch', '-d', branchName], workDir);
  }
}
