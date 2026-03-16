import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Shared fields present in every config
// ---------------------------------------------------------------------------

interface BaseConfig {
  agentId: string;
  /** Role ID — resolved against roles.json at runtime. Default: "implementer". */
  role: string;
  agentTags: string[];
  workDir: string;
  claudeModel: string;
  claudeMaxBudgetUsd?: number;
  /**
   * When true, stream human-readable Claude output to stderr.
   * Default: true if stderr is a TTY, false otherwise.
   * Overridden by --interactive / --no-interactive.
   */
  interactive: boolean;
}

// ---------------------------------------------------------------------------
// Mode-specific shapes
// ---------------------------------------------------------------------------

/**
 * Conductor pre-selected a specific task for this worker.
 * The worker will claim it by ID on startup (agent ID is still ephemeral).
 */
export interface ConductedConfig extends BaseConfig {
  mode: 'conducted';
  taskId: string;
}

/**
 * No conductor — the worker claims the next suitable task itself before
 * spawning Claude. Agent ID is ephemeral (generated on startup).
 */
export interface OneShotConfig extends BaseConfig {
  mode: 'one-shot';
}

export type WorkerConfig = ConductedConfig | OneShotConfig;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseConfig(): WorkerConfig {
  const { values } = parseArgs({
    options: {
      'task-id':        { type: 'string' },
      'role':           { type: 'string' },
      'interactive':    { type: 'boolean' },
      'no-interactive': { type: 'boolean' },
    },
    strict: true,
  });

  const taskId  = values['task-id'];

  const role = values['role'] ?? process.env['WORKER_ROLE'] ?? 'implementer';

  // Interactive defaults to TTY detection; explicit flags override.
  let interactive = process.stderr.isTTY ?? false;
  if (values['interactive'] === true)    interactive = true;
  if (values['no-interactive'] === true) interactive = false;

  const rawTags = process.env['AGENT_TAGS'] ?? '';
  const agentTags = rawTags
    ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const workDir            = process.env['WORK_DIR']             ?? process.cwd();
  const claudeModel        = process.env['CLAUDE_MODEL']         ?? 'sonnet';
  const rawBudget          = process.env['CLAUDE_MAX_BUDGET_USD'];
  const claudeMaxBudgetUsd = rawBudget !== undefined ? parseFloat(rawBudget) : undefined;

  // Agent ID is always ephemeral — generated fresh every invocation.
  const agentId = randomUUID();

  const base: BaseConfig = {
    agentId, role, interactive, agentTags, workDir, claudeModel, claudeMaxBudgetUsd,
  };

  if (taskId !== undefined) {
    return {
      ...base,
      mode: 'conducted',
      taskId,
    };
  }

  return {
    ...base,
    mode: 'one-shot',
  };
}
