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
  claim,
  complete,
  fail,
  publish,
  subtree,
  ready,
  getDepResults,
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
async function run<T>(fn: () => Promise<T>): Promise<void> {
  let code = 0;
  try {
    await initSchema();
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
  .action(async (description: string, opts: {
    payload?: string; dependsOn: string[]; parent?: string;
    priority: number; createdBy: string; ready?: boolean;
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
  .action(async (opts: { agent: string; draft?: boolean }) => {
    await run(() => claim(opts.agent, opts.draft ?? false));
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

// ── tq publish ──────────────────────────────────────────────────────────────

program
  .command('publish <id>')
  .description('Mark a draft task as ready (transition to eligible/pending) — for task-refiner agents')
  .option('--agent <id>', 'Agent ID', DEFAULT_AGENT_ID)
  .action(async (id: string, opts: { agent: string }) => {
    await run(() => publish(id, opts.agent));
  });

// ── tq list ─────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List tasks')
  .option('--status <status>', 'Filter by status (draft|pending|eligible|in_progress|completed|failed)')
  .option('--parent <id>', 'Filter by parent ID (pass empty string for root tasks)')
  .option('--created-by <id>', 'Filter by creator')
  .action(async (opts: { status?: string; parent?: string; createdBy?: string }) => {
    await run(async () => {
      const filters: ListFilters = {};
      if (opts.status)  filters.status     = opts.status as TaskStatus;
      if (opts.parent !== undefined) filters.parent_id = opts.parent;
      if (opts.createdBy)  filters.created_by = opts.createdBy;
      return listTasks(filters);
    });
  });

// ── tq show ─────────────────────────────────────────────────────────────────

program
  .command('show <id>')
  .description('Show a single task')
  .action(async (id: string) => {
    await run(async () => {
      const task = await getTask(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      return task;
    });
  });

// ── tq ready ────────────────────────────────────────────────────────────────

program
  .command('ready')
  .description('List all currently claimable tasks, highest priority first')
  .action(async () => {
    await run(() => ready());
  });

// ── tq subtree ──────────────────────────────────────────────────────────────

program
  .command('subtree <id>')
  .description('Show all descendants of a task with a status rollup')
  .action(async (id: string) => {
    await run(() => subtree(id));
  });

// ── tq dep-results ──────────────────────────────────────────────────────────

program
  .command('dep-results <id>')
  .description('Show the result_payload of each dependency of a task')
  .action(async (id: string) => {
    await run(() => getDepResults(id));
  });

program.parse();
