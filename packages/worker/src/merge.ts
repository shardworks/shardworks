import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
 */
export async function mergeWorktreeToMain(
  taskId: string,
  workDir: string,
): Promise<MergeResult> {
  const branchName  = `worktree-${taskId}`;
  const worktreePath = join(workDir, '.claude', 'worktrees', taskId);

  // ------------------------------------------------------------------
  // 1. Check the branch exists
  // ------------------------------------------------------------------
  const verifyBranch = await exec('git', ['rev-parse', '--verify', branchName], workDir);
  if (verifyBranch.exitCode !== 0) {
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
  // 4. Merge the worktree branch into main (--no-ff for clear history)
  // ------------------------------------------------------------------
  const mergeMsg = `Merge task ${taskId}`;
  const mergeResult = await exec(
    'git', ['merge', branchName, '--no-ff', '-m', mergeMsg], workDir,
  );

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

async function cleanupWorktree(
  workDir: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  // Remove the worktree directory if it still exists
  if (existsSync(worktreePath)) {
    await exec('git', ['worktree', 'remove', '--force', worktreePath], workDir);
  }
  // Delete the local branch (branch may already be gone if worktree was removed)
  await exec('git', ['branch', '-d', branchName], workDir);
}
