#!/usr/bin/env node
import { Command } from 'commander';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { pool } from './db.js';
import { initSchema } from './schema.js';
import {
  enqueue,
  batchEnqueue,
  getTask,
  listTasks,
  listHumanTasks,
  claim,
  claimById,
  complete,
  fail,
  release,
  publish,
  link,
  unlink,
  reparent,
  edit,
  cancel,
  retryTask,
  rejectTask,
  heartbeat,
  releaseTimedOut,
  subtree,
  ready,
  reap,
  getDepResults,
  relate,
  getRelations,
  getMaxPriority,
  statusCounts,
  history,
  diff,
  compact,
  branchMerge,
  branchCreate,
  branchList,
  type ListFilters,
} from './tasks.js';
import type { EnqueueInput, BatchEnqueueInput, TaskStatus } from '@shardworks/shared-types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CREATED_BY =
  process.env['USER'] ?? process.env['USERNAME'] ?? 'human';

const DEFAULT_AGENT_ID =
  process.env['AGENT_ID'] ?? `${hostname()}-${process.pid}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run an operation, print JSON result to stdout, errors to stderr. */
async function run<T>(fn: () => Promise<T>, opts: { skipSchema?: boolean } = {}): Promise<void> {
  let code = 0;
  try {
    if (!opts.skipSchema) await initSchema();
    const result = await fn();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ error: 'Error', message }, null, 2) + '\n');
    code = 1;
  } finally {
    await pool.end();
  }
  process.exit(code);
}

/** Commander collector for repeatable options: --flag a --flag b → ['a','b'] */
function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command()
  .name('tq')
  .description('Shardworks task queue')
  .version('0.0.1');

// ── tq enqueue ──────────────────────────────────────────────────────────────

program
  .command('enqueue <description>')
  .description('Enqueue a single task (created as draft by default)')
  .option('-p, --payload <json>', 'JSON payload for the agent')
  .option('--depends-on <id>', 'Dependency task ID (repeatable)', collect, [] as string[])
  .option('--parent <id>', 'Parent task ID')
  .option('--priority <n>', 'Priority — higher is claimed first', (v) => parseInt(v, 10), 0)
  .option('--created-by <id>', 'Creator identifier', DEFAULT_CREATED_BY)
  .option('--ready', 'Skip draft status; make the task eligible/pending immediately')
  .option('--assigned-role <role>', 'Role that should complete this task (e.g. planner, implementer)')
  .action(async (description: string, opts: {
    payload?: string; dependsOn: string[]; parent?: string;
    priority: number; createdBy: string; ready?: boolean; assignedRole?: string;
  }) => {
    await run(async () => {
      const input: EnqueueInput = {
        description,
        created_by: opts.createdBy,
        priority: opts.priority,
        dependencies: opts.dependsOn,
        parent_id: opts.parent,
        payload: opts.payload ? JSON.parse(opts.payload) : undefined,
        skipDraft: opts.ready ?? false,
        assigned_role: opts.assignedRole,
      };
      return enqueue(input);
    });
  });

// ── tq add ──────────────────────────────────────────────────────────────────

program
  .command('add [description...]')
  .description(
    'Quickly add a new top-priority task.\n' +
    'All positional arguments are joined as the task description.\n' +
    'Default priority is max(existing) + 1 so this task runs next.',
  )
  .option('--priority <n>', 'Override priority (default: highest existing + 1)', (v) => parseInt(v, 10))
  .option('--ready', 'Skip draft; create as eligible/pending immediately')
  .option('--created-by <id>', 'Creator identifier', DEFAULT_CREATED_BY)
  .action(async (words: string[], opts: { priority?: number; ready?: boolean; createdBy: string }) => {
    await run(async () => {
      const description = words.join(' ').trim();
      if (!description) throw new Error('Task description is required');

      const priority = opts.priority !== undefined
        ? opts.priority
        : (await getMaxPriority()) + 1;

      const input: EnqueueInput = {
        description,
        created_by: opts.createdBy,
        priority,
        dependencies: [],
        skipDraft: opts.ready ?? false,
      };
      return enqueue(input);
    });
  });

// ── tq batch ────────────────────────────────────────────────────────────────

program
  .command('batch <file>')
  .description('Batch-enqueue a task graph from a JSON file (use - for stdin)')
  .option('--created-by <id>', 'Creator identifier', DEFAULT_CREATED_BY)
  .option('--ready', 'Skip draft status; make all tasks eligible/pending immediately')
  .action(async (file: string, opts: { createdBy: string; ready?: boolean }) => {
    await run(async () => {
      const raw = file === '-'
        ? readFileSync('/dev/stdin', 'utf8')
        : readFileSync(file, 'utf8');
      const input = JSON.parse(raw) as BatchEnqueueInput;
      if (!input.created_by) input.created_by = opts.createdBy;
      if (opts.ready) input.skipDraft = true;
      return batchEnqueue(input);
    });
  });

// ── tq claim ────────────────────────────────────────────────────────────────

program
  .command('claim')
  .description('Claim the next eligible task (use --draft to claim draft tasks for refinement)')
  .option('--agent <id>', 'Agent ID', DEFAULT_AGENT_ID)
  .option('--draft', 'Claim a draft task instead of an eligible one (for task-refiner agents)')
  .option('--role <role>', 'Only claim tasks with this exact assigned_role (no fallback to unassigned tasks). Omit to claim only unassigned (NULL) tasks.')
  .option('--capability <tag>', 'Capability tag this agent supports (repeatable). Only tasks whose required tags are a subset of the provided capabilities will be claimed. Omit to claim any task regardless of tags.', collect, [] as string[])
  .action(async (opts: { agent: string; draft?: boolean; role?: string; capability: string[] }) => {
    await run(() => claim(opts.agent, opts.capability, opts.draft ?? false, opts.role));
  });

// ── tq claim-id ─────────────────────────────────────────────────────────────

program
  .command('claim-id <task-id>')
  .description('Claim a specific task by ID (must be eligible, or draft if --draft is passed)')
  .option('--agent <id>', 'Agent ID', DEFAULT_AGENT_ID)
  .option('--draft', 'Also allow claiming draft tasks')
  .action(async (taskId: string, opts: { agent: string; draft?: boolean }) => {
    await run(() => claimById(taskId, opts.agent, opts.draft ?? false));
  });

// ── tq complete ─────────────────────────────────────────────────────────────

program
  .command('complete <id>')
  .description('Mark a task as completed')
  .option('--agent <id>', 'Agent ID', DEFAULT_AGENT_ID)
  .option('-r, --result <json>', 'Result payload (JSON)')
  .action(async (id: string, opts: { agent: string; result?: string }) => {
    await run(() =>
      complete(id, opts.agent, opts.result ? JSON.parse(opts.result) : undefined),
    );
  });

// ── tq fail ─────────────────────────────────────────────────────────────────

program
  .command('fail <id>')
  .description('Mark a task as failed')
  .requiredOption('--reason <text>', 'Failure reason')
  .option('--agent <id>', 'Agent ID', DEFAULT_AGENT_ID)
  .action(async (id: string, opts: { reason: string; agent: string }) => {
    await run(() => fail(id, opts.agent, opts.reason));
  });

// ── tq release ──────────────────────────────────────────────────────────────

program
  .command('release <id>')
  .description('Release an in_progress task back to eligible (for retry after interruption)')
  .option('--agent <id>', 'Agent ID', DEFAULT_AGENT_ID)
  .option('--force', 'Skip agent ownership check (operator override)')
  .action(async (id: string, opts: { agent: string; force?: boolean }) => {
    await run(() => release(id, opts.agent, opts.force ?? false));
  });

// ── tq heartbeat ─────────────────────────────────────────────────────────────

program
  .command('heartbeat <id>')
  .description('Refresh claimed_at on an in_progress task to signal the agent is still alive')
  .option('--agent <id>', 'Agent ID', DEFAULT_AGENT_ID)
  .action(async (id: string, opts: { agent: string }) => {
    await run(() => heartbeat(id, opts.agent));
  });

// ── tq retry ────────────────────────────────────────────────────────────────

program
  .command('retry <id>')
  .description('Re-queue a failed or blocked task, resetting attempt count')
  .option('--agent <id>', 'Actor identifier', DEFAULT_AGENT_ID)
  .action(async (id: string, opts: { agent: string }) => {
    await run(() => retryTask(id, opts.agent));
  });

// ── tq reject ────────────────────────────────────────────────────────────────

program
  .command('reject <id>')
  .description(
    'Operator tool: reset a completed or failed task for re-execution.\n' +
    'Clears result_payload, result_summary, claimed_by, claimed_at, completed_at\n' +
    'and resets attempt_count to 0.  Optionally cleans up the git worktree and\n' +
    'branch (worktree-<id>) when --work-dir is provided.',
  )
  .option('--reason <text>', 'Rejection reason (stored as audit trail in result_payload)')
  .option('--agent <id>', 'Actor identifier', DEFAULT_AGENT_ID)
  .option(
    '--work-dir <path>',
    'Repo root for worktree cleanup — when provided, removes the worktree\n' +
    '  directory (.claude/worktrees/<id>) and deletes the worktree-<id> branch.',
  )
  .action(async (id: string, opts: { reason?: string; agent: string; workDir?: string }) => {
    await run(async () => {
      // 1. Reset task state in DB
      const task = await rejectTask(id, opts.agent, opts.reason);

      // 2. Optionally clean up the git worktree and local branch
      let worktreeCleanup: Record<string, unknown> | null = null;
      if (opts.workDir) {
        const { existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        const branchName   = `worktree-${id}`;
        const worktreePath = join(opts.workDir, '.claude', 'worktrees', id);

        const cleanup: { worktree?: string; branch?: string } = {};

        // Remove the git worktree (directory + registration) if it exists
        if (existsSync(worktreePath)) {
          try {
            await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: opts.workDir });
            cleanup.worktree = 'removed';
          } catch (err) {
            cleanup.worktree = `error: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          cleanup.worktree = 'not-found (skipped)';
        }

        // Delete the local branch (force-delete, the branch may not be merged)
        try {
          await execFileAsync('git', ['branch', '-D', branchName], { cwd: opts.workDir });
          cleanup.branch = 'deleted';
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Not an error if the branch simply doesn't exist
          cleanup.branch = msg.includes('not found') || msg.includes('error: branch')
            ? 'not-found (skipped)'
            : `error: ${msg}`;
        }

        worktreeCleanup = { worktree_path: worktreePath, branch: branchName, ...cleanup };
      }

      return { task, ...(worktreeCleanup ? { worktree_cleanup: worktreeCleanup } : {}) };
    });
  });

// ── tq publish ──────────────────────────────────────────────────────────────

program
  .command('publish <id>')
  .description('Mark a draft task as ready (transition to eligible/pending) — for task-refiner agents')
  .option('--agent <id>', 'Agent ID', DEFAULT_AGENT_ID)
  .action(async (id: string, opts: { agent: string }) => {
    await run(() => publish(id, opts.agent));
  });

// ── tq link ───────────────────────────────────────────────────────────────

program
  .command('link <task-id> <dep-id>')
  .description('Add a dependency edge: task-id depends on dep-id')
  .option('--agent <id>', 'Actor identifier', DEFAULT_AGENT_ID)
  .action(async (taskId: string, depId: string, opts: { agent: string }) => {
    await run(() => link(taskId, depId, opts.agent));
  });

// ── tq unlink ─────────────────────────────────────────────────────────────

program
  .command('unlink <task-id> <dep-id>')
  .description('Remove a dependency edge')
  .option('--agent <id>', 'Actor identifier', DEFAULT_AGENT_ID)
  .action(async (taskId: string, depId: string, opts: { agent: string }) => {
    await run(() => unlink(taskId, depId, opts.agent));
  });

// ── tq reparent ───────────────────────────────────────────────────────────

program
  .command('reparent <task-id> <new-parent-id>')
  .description('Move a task under a new parent (use "root" to make it a root task)')
  .option('--agent <id>', 'Actor identifier', DEFAULT_AGENT_ID)
  .action(async (taskId: string, newParentId: string, opts: { agent: string }) => {
    const parentId = newParentId === 'root' ? null : newParentId;
    await run(() => reparent(taskId, parentId, opts.agent));
  });

// ── tq edit ───────────────────────────────────────────────────────────────

program
  .command('edit <task-id>')
  .description('Edit a task\'s description, payload, priority, or assigned_role (draft/pending/eligible only)')
  .option('--description <text>', 'New description')
  .option('-p, --payload <json>', 'New payload (JSON)')
  .option('--priority <n>', 'New priority', (v) => parseInt(v, 10))
  .option('--assigned-role <role>', 'New assigned role (use "none" to clear)')
  .option('--agent <id>', 'Actor identifier', DEFAULT_AGENT_ID)
  .action(async (taskId: string, opts: {
    description?: string; payload?: string; priority?: number; assignedRole?: string; agent: string;
  }) => {
    await run(() => edit(taskId, opts.agent, {
      description: opts.description,
      payload: opts.payload ? JSON.parse(opts.payload) : undefined,
      priority: opts.priority,
      assigned_role: opts.assignedRole !== undefined
        ? (opts.assignedRole === 'none' ? null : opts.assignedRole)
        : undefined,
    }));
  });

// ── tq cancel ─────────────────────────────────────────────────────────────

program
  .command('cancel <task-id>')
  .description('Cancel a task without claiming it (for deduplication / cleanup)')
  .requiredOption('--reason <text>', 'Cancellation reason')
  .option('--agent <id>', 'Actor identifier', DEFAULT_AGENT_ID)
  .action(async (taskId: string, opts: { reason: string; agent: string }) => {
    await run(() => cancel(taskId, opts.agent, opts.reason));
  });

// ── tq list ─────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List tasks')
  .option('--status <status>', 'Filter by status (draft|pending|eligible|in_progress|completed|failed)')
  .option('--parent <id>', 'Filter by parent ID (pass empty string for root tasks)')
  .option('--created-by <id>', 'Filter by creator')
  .option('--assigned-role <role>', 'Filter by assigned role (use "none" for unassigned tasks)')
  .action(async (opts: { status?: string; parent?: string; createdBy?: string; assignedRole?: string }) => {
    await run(async () => {
      const filters: ListFilters = {};
      if (opts.status)  filters.status     = opts.status as TaskStatus;
      if (opts.parent !== undefined) filters.parent_id = opts.parent;
      if (opts.createdBy)  filters.created_by = opts.createdBy;
      if (opts.assignedRole !== undefined) {
        filters.assigned_role = opts.assignedRole === 'none' ? null : opts.assignedRole;
      }
      return listTasks(filters);
    }, { skipSchema: true });
  });

// ── tq humans ───────────────────────────────────────────────────────────────

program
  .command('humans')
  .description(
    'List tasks flagged for human attention (assigned_role=human), with enriched context.\n' +
    'Each entry includes the alert type, the referenced task that triggered the alert,\n' +
    'and the work log path for that task.',
  )
  .option('--all', 'Include resolved tasks (completed, cancelled, failed)')
  .action(async (opts: { all?: boolean }) => {
    await run(() => listHumanTasks(opts.all ?? false), { skipSchema: true });
  });

// ── tq show ─────────────────────────────────────────────────────────────────
program
  .command('show <id>')
  .description('Show a single task')
  .option('--full-result', 'Always include result_payload even when result_summary is present')
  .action(async (id: string, opts: { fullResult?: boolean }) => {
    await run(async () => {
      const task = await getTask(id, opts.fullResult ?? false);
      if (!task) throw new Error(`Task not found: ${id}`);
      return task;
    }, { skipSchema: true });
  });

// ── tq ready ────────────────────────────────────────────────────────────────

program
  .command('ready')
  .description('List all currently claimable tasks, highest priority first')
  .action(async () => {
    await run(() => ready(), { skipSchema: true });
  });

// ── tq subtree ──────────────────────────────────────────────────────────────

program
  .command('subtree <id>')
  .description('Show all descendants of a task with a status rollup')
  .action(async (id: string) => {
    await run(() => subtree(id), { skipSchema: true });
  });

// ── tq dep-results ──────────────────────────────────────────────────────────

program
  .command('dep-results <id>')
  .description('Show the result_payload of each dependency of a task')
  .action(async (id: string) => {
    await run(() => getDepResults(id), { skipSchema: true });
  });

// ── tq reap ─────────────────────────────────────────────────────────────────

/**
 * Parse a human-friendly duration string like "30m", "2h", "1d" into
 * milliseconds. Supports: s (seconds), m (minutes), h (hours), d (days).
 */
function parseDuration(input: string): number {
  const match = input.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (!match) throw new Error(`Invalid duration "${input}". Use e.g. 30m, 2h, 1d.`);
  const value = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multipliers[unit]!;
}

program
  .command('reap')
  .description('Find (and optionally release) stale in_progress tasks')
  .requiredOption('--stale-after <duration>', 'Duration threshold (e.g. 30m, 2h, 1d)')
  .option('--release', 'Release stale tasks back to eligible (default: dry-run list only)')
  .action(async (opts: { staleAfter: string; release?: boolean }) => {
    await run(async () => {
      const ms = parseDuration(opts.staleAfter);
      return reap(ms, opts.release ?? false);
    });
  });

// ── tq release-timed-out ────────────────────────────────────────────────────

program
  .command('release-timed-out')
  .description(
    'Auto-release in_progress tasks whose timeout_seconds has elapsed since claimed_at.\n' +
    'Tasks with remaining attempts are re-queued as eligible; exhausted tasks are failed.\n' +
    'Safe to run via cron or as an operator command.',
  )
  .action(async () => {
    await run(() => releaseTimedOut());
  });

// ── tq relate ───────────────────────────────────────────────────────────────

program
  .command('relate <from-task-id> <to-task-id> <type>')
  .description(
    'Create a typed (non-scheduling) relationship between two tasks.\n' +
    'Valid types: relates_to, duplicates, supersedes, replies_to, spawned_from',
  )
  .option('--agent <id>', 'Actor identifier', DEFAULT_AGENT_ID)
  .action(async (fromTaskId: string, toTaskId: string, type: string, opts: { agent: string }) => {
    await run(() => relate(fromTaskId, toTaskId, type, opts.agent));
  });

// ── tq relations ─────────────────────────────────────────────────────────────

program
  .command('relations <task-id>')
  .description('List all typed relationships for a task (outgoing and incoming)')
  .action(async (taskId: string) => {
    await run(() => getRelations(taskId), { skipSchema: true });
  });

// ── tq status-counts ─────────────────────────────────────────────────────────

program
  .command('status-counts')
  .description('Show task counts grouped by status (optionally filtered by tag)')
  .option('--tag <tag>', 'Only count tasks with this tag')
  .action(async (opts: { tag?: string }) => {
    await run(() => statusCounts(opts.tag));
  });

// ── tq kick ──────────────────────────────────────────────────────────────────

program
  .command('kick')
  .description(
    'Append a spawn_request signal to the conductor signals file.\n' +
    'The conductor will wake up immediately (if sleeping) and spawn a worker.\n' +
    'The spawn bypasses the maxWorkers cap — use when you want immediate processing.',
  )
  .option('--task-id <id>', 'Hint: which task to process next (optional)')
  .option('--role <role>', 'Worker role to spawn: refiner | implementer (auto-detected when omitted)')
  .option('--requested-by <id>', 'Who is requesting the spawn', DEFAULT_CREATED_BY)
  .option('--work-dir <path>', 'Conductor work dir (default: $WORK_DIR or cwd)')
  .action(async (opts: {
    taskId?: string;
    role?: string;
    requestedBy: string;
    workDir?: string;
  }) => {
    // This command writes directly to the signals file — no DB needed.
    const { appendFile, mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const workDir = opts.workDir ?? process.env['WORK_DIR'] ?? process.cwd();
    const signalPath = join(workDir, 'data', 'conductor-signals.jsonl');
    let code = 0;
    try {
      await mkdir(dirname(signalPath), { recursive: true });
      const signal = {
        type: 'spawn_request',
        ts: new Date().toISOString(),
        requested_by: opts.requestedBy,
        ...(opts.taskId !== undefined && { task_id: opts.taskId }),
        ...(opts.role !== undefined && { role: opts.role }),
      };
      await appendFile(signalPath, JSON.stringify(signal) + '\n', 'utf8');
      process.stdout.write(JSON.stringify({
        ok: true,
        work_dir: workDir,
        signal,
      }, null, 2) + '\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(JSON.stringify({ error: 'Error', message }, null, 2) + '\n');
      code = 1;
    } finally {
      // No DB pool to close for this command.
      await pool.end().catch(() => undefined);
    }
    process.exit(code);
  });

// ── tq history ───────────────────────────────────────────────────────────────

program
  .command('history <id>')
  .description('Show all Dolt commits that modified a given task (read-only)')
  .action(async (id: string) => {
    await run(() => history(id), { skipSchema: true });
  });

// ── tq diff ──────────────────────────────────────────────────────────────────

program
  .command('diff <commit-a> <commit-b>')
  .description(
    'Show task changes between two Dolt commits (read-only).\n' +
    'Returns every task row that was added, modified, or removed,\n' +
    'with before/after values for status, description, priority,\n' +
    'claimed_by, and assigned_role.\n' +
    'Commits may be hashes, branch names, or tags.',
  )
  .action(async (commitA: string, commitB: string) => {
    await run(() => diff(commitA, commitB), { skipSchema: true });
  });

// ── tq compact ───────────────────────────────────────────────────────────────

program
  .command('compact <id>')
  .description(
    'Compact a completed task: write result_summary, null out result_payload.\n' +
    'The original result_payload survives in Dolt history at the preceding commit.\n' +
    'Use --subtree to recursively compact all completed descendants too.',
  )
  .option('--summary <json>', 'JSON summary to store as result_summary', '{}')
  .option('--subtree', 'Also compact all completed descendants')
  .option('--agent <id>', 'Agent/user performing the operation', DEFAULT_AGENT_ID)
  .action(async (id: string, opts: { summary: string; subtree?: boolean; agent: string }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.summary);
    } catch {
      process.stderr.write(JSON.stringify({ error: 'Error', message: `--summary is not valid JSON: ${opts.summary}` }, null, 2) + '\n');
      await pool.end();
      process.exit(1);
    }
    await run(() => compact(id, parsed, opts.agent, opts.subtree ?? false));
  });

// ── tq branch ────────────────────────────────────────────────────────────────

const branchCmd = program
  .command('branch')
  .description('Dolt branch management commands');

// tq branch create <name> [--from <branch>]
branchCmd
  .command('create <name>')
  .description('Create a new Dolt branch from HEAD (or from --from <branch>)')
  .option('--from <branch>', 'Source branch to copy from (default: current HEAD)')
  .action(async (name: string, opts: { from?: string }) => {
    await run(() => branchCreate(name, opts.from), { skipSchema: true });
  });

// tq branch list
branchCmd
  .command('list')
  .description('List all Dolt branches')
  .action(async () => {
    await run(() => branchList(), { skipSchema: true });
  });

// tq branch merge <source> --into <target>
branchCmd
  .command('merge <source>')
  .description(
    'Merge <source> branch into a target branch.\n' +
    'Checks out the target branch, then calls dolt_merge(source).\n' +
    'Conflicts are returned as {conflicts: [...]} rather than thrown.\n' +
    'Returns {source, target, fast_forward, conflicts}.',
  )
  .requiredOption('--into <branch>', 'Target branch to merge into')
  .action(async (source: string, opts: { into: string }) => {
    await run(() => branchMerge(source, opts.into), { skipSchema: true });
  });

program.parse();
