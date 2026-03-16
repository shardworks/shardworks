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

/** Conductor pre-claimed a specific task and dispatched it to this worker. */
export interface ConductedConfig extends BaseConfig {
  mode: 'conducted';
  taskId: string;
  /** Claude session UUID from a previous invocation; enables --resume. */
  resumeSession?: string;
}

/**
 * No conductor — the worker claims the next suitable task itself before
 * spawning Claude. Agent ID is ephemeral (generated on startup).
 * No resume across runs.
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
      'agent-id':       { type: 'string' },
      'resume-session': { type: 'string' },
      'role':           { type: 'string' },
      'interactive':    { type: 'boolean' },
      'no-interactive': { type: 'boolean' },
    },
    strict: true,
  });

  const taskId  = values['task-id'];
  const agentId = values['agent-id'];

  // Validate: either both task-id and agent-id are present (conducted),
  // or neither is (one-shot). Mixed is an error.
  if ((taskId === undefined) !== (agentId === undefined)) {
    throw new Error(
      taskId === undefined
        ? '--task-id is required when --agent-id is provided'
        : '--agent-id is required when --task-id is provided',
    );
  }

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

  const base: BaseConfig = {
    agentId: '', role, interactive, agentTags, workDir, claudeModel, claudeMaxBudgetUsd,
  };

  if (taskId !== undefined && agentId !== undefined) {
    return {
      ...base,
      mode: 'conducted',
      agentId,
      taskId,
      resumeSession: values['resume-session'],
    };
  }

  return {
    ...base,
    mode: 'one-shot',
    agentId: randomUUID(),
  };
}
