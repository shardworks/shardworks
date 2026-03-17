import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manager, ManagerResult, TickContext } from './manager.js';

// ---------------------------------------------------------------------------
// JanitorManager
// ---------------------------------------------------------------------------

/**
 * Clean up worktrees for terminal tasks with no uncommitted changes.
 *
 * Responsibilities:
 *   - Scan the worktree directory for completed/failed task worktrees.
 *   - Verify the worktree has been merged (no uncommitted changes).
 *   - Remove stale worktree directories to keep the filesystem lean.
 *   - Run at most once every `cleanupIntervalMs` to avoid I/O pressure.
 *
 * Safety:
 *   - Only removes directories matching the task ID pattern (tq-*).
 *   - Checks git status before removal — never removes worktrees with
 *     uncommitted changes.
 *   - Errors are non-fatal; logged and skipped.
 */
export class JanitorManager implements Manager {
  readonly name = 'janitor';

  /** Minimum interval between cleanup runs (default: 5 minutes). */
  private readonly cleanupIntervalMs: number;
  /** Timestamp of the last cleanup run. */
  private lastCleanupAt = 0;

  constructor(opts?: { cleanupIntervalMs?: number }) {
    this.cleanupIntervalMs = opts?.cleanupIntervalMs ?? 5 * 60 * 1000;
  }

  async run(ctx: TickContext): Promise<ManagerResult> {
    // Throttle: only run cleanup periodically
    const now = Date.now();
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) {
      return { summary: { skipped: true, reason: 'throttled' } };
    }

    this.lastCleanupAt = now;

    const worktreeDir = join(ctx.cfg.workDir, '.claude', 'worktrees');
    let entries: string[];
    try {
      entries = await readdir(worktreeDir);
    } catch {
      // Worktree directory doesn't exist — nothing to clean
      return { summary: { cleaned: 0, reason: 'no_worktree_dir' } };
    }

    // Filter to task-like directory names (tq-*)
    const taskDirs = entries.filter((e) => e.startsWith('tq-'));

    let cleaned = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const dir of taskDirs) {
      const fullPath = join(worktreeDir, dir);

      try {
        // Verify it's a directory
        const s = await stat(fullPath);
        if (!s.isDirectory()) continue;

        // Check if the task is in a terminal state
        const isTerminal = await this.isTerminalTask(ctx, dir);
        if (!isTerminal) {
          skipped++;
          continue;
        }

        // Check for uncommitted changes before removing
        const hasChanges = await this.hasUncommittedChanges(fullPath);
        if (hasChanges) {
          ctx.log('debug', `Janitor: skipping ${dir} — has uncommitted changes`);
          skipped++;
          continue;
        }

        // Safe to remove — first detach the git worktree, then remove the directory
        await this.removeWorktree(ctx, fullPath, dir);
        cleaned++;
        ctx.log('debug', `Janitor: cleaned worktree ${dir}`);
      } catch (err) {
        errors.push(`${dir}: ${String(err)}`);
        ctx.log('debug', `Janitor: error processing ${dir}`, { error: String(err) });
      }
    }

    if (cleaned > 0) {
      ctx.log('info', `Janitor: cleaned ${cleaned} stale worktree(s)`, {
        cleaned,
        skipped,
        errors: errors.length,
      });
    }

    return {
      summary: { cleaned, skipped, errors: errors.length },
    };
  }

  /**
   * Check if a task ID corresponds to a terminal task (completed, failed, cancelled).
   */
  private async isTerminalTask(ctx: TickContext, taskId: string): Promise<boolean> {
    try {
      const { exec } = await import('@shardworks/shared-types');
      const { stdout, exitCode } = await exec('tq', ['show', taskId], ctx.cfg.workDir);
      if (exitCode !== 0) return false;

      const task = JSON.parse(stdout.trim()) as { status: string };
      return ['completed', 'failed', 'cancelled'].includes(task.status);
    } catch {
      return false;
    }
  }

  /**
   * Check if a worktree directory has uncommitted changes.
   */
  private async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    try {
      const { exec } = await import('@shardworks/shared-types');
      const { stdout, exitCode } = await exec(
        'git',
        ['status', '--porcelain'],
        worktreePath,
      );
      if (exitCode !== 0) return true; // Assume dirty on error
      return stdout.trim().length > 0;
    } catch {
      return true; // Assume dirty on error
    }
  }

  /**
   * Remove a worktree by first detaching it from git, then removing the directory.
   */
  private async removeWorktree(
    ctx: TickContext,
    fullPath: string,
    dirName: string,
  ): Promise<void> {
    try {
      // Try to remove via git worktree remove (handles git bookkeeping)
      const { exec } = await import('@shardworks/shared-types');
      const { exitCode } = await exec(
        'git',
        ['worktree', 'remove', '--force', fullPath],
        ctx.cfg.workDir,
      );

      if (exitCode !== 0) {
        // Fallback: manual directory removal
        ctx.log('debug', `Janitor: git worktree remove failed for ${dirName}, falling back to rm`);
        await rm(fullPath, { recursive: true, force: true });
      }
    } catch {
      // Last resort: try direct removal
      await rm(fullPath, { recursive: true, force: true });
    }
  }
}
