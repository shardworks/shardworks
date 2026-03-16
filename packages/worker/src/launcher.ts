import { spawn } from 'node:child_process';
import type { ConductedConfig } from './config.js';

// ---------------------------------------------------------------------------
// Claude JSON output shape (--output-format json)
// ---------------------------------------------------------------------------

interface ClaudeJsonOutput {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd?: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface LaunchResult {
  exitCode: number;
  /** Claude session UUID read from JSON output. Null if output could not be parsed. */
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function renderSystemPrompt(config: ConductedConfig): string {
  const tagsLine = config.agentTags.length > 0
    ? `\nCapability tags: ${config.agentTags.join(', ')}`
    : '';

  return [
    `You are an autonomous software engineering agent.`,
    `Your agent ID: ${config.agentId}${tagsLine}`,
    ``,
    `Use ${config.agentId} as the --agent value in all tq commands (complete, fail).`,
    ``,
    `Refer to CLAUDE.md for the full tq CLI reference.`,
  ].join('\n');
}

function renderPrompt(config: ConductedConfig): string {
  return [
    `Work on task ${config.taskId}.`,
    ``,
    `Check the task with \`tq show ${config.taskId}\`. If the task is in_progress and you have`,
    `prior conversation history for it, continue from where you left off.`,
    `If this is a fresh start, read the description and payload, fetch dependency`,
    `results with \`tq dep-results ${config.taskId}\`, then do the work.`,
    ``,
    `When done, use /tq-complete. If you cannot complete the task, use /tq-fail`,
    `with a clear reason.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

function buildArgs(config: ConductedConfig): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--model', config.claudeModel,
    '--system-prompt', renderSystemPrompt(config),
  ];

  if (config.resumeSession) {
    // Resume existing session — worktree is restored automatically by Claude
    args.push('--resume', config.resumeSession);
  } else {
    // First run — create a worktree named after the agent ID
    args.push('--worktree', config.agentId);
  }

  if (config.claudeMaxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(config.claudeMaxBudgetUsd));
  }

  args.push(renderPrompt(config));

  return args;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export async function launch(config: ConductedConfig): Promise<LaunchResult> {
  const args = buildArgs(config);

  const child = spawn('claude', args, {
    cwd: config.workDir,
    // stdout piped so we can capture the JSON output
    // stderr inherited so Claude's progress output reaches the terminal
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      let sessionId: string | null = null;
      try {
        const output = JSON.parse(stdout) as ClaudeJsonOutput;
        sessionId = output.session_id ?? null;
      } catch {
        // stdout wasn't valid JSON — process-level failure before any output
      }
      resolve({ exitCode: code ?? 1, sessionId });
    });
  });
}
