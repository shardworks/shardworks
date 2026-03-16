import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { ConductedConfig } from './config.js';
import { loadRole, renderSystemPrompt, renderWorkPrompt } from './roles.js';

// ---------------------------------------------------------------------------
// Claude stream-json output shape (--output-format stream-json)
// ---------------------------------------------------------------------------

/** A single line emitted by `claude -p --output-format stream-json`. */
interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface LaunchResult {
  exitCode: number;
  /** Claude session UUID read from stream-json output. Null if output could not be parsed. */
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// Log directory
// ---------------------------------------------------------------------------

/** Resolve the base directory for work logs. */
function workLogsDir(workDir: string): string {
  return process.env['WORK_LOGS_DIR'] ?? join(workDir, 'data', 'work-logs');
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

function buildArgs(config: ConductedConfig): string[] {
  const role = loadRole(config.role, config.workDir);
  const vars = { agentId: config.agentId, taskId: config.taskId, agentTags: config.agentTags };

  const args: string[] = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--model', config.claudeModel,
    '--system-prompt', renderSystemPrompt(role, vars),
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

  args.push(renderWorkPrompt(role, vars));

  return args;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export async function launch(config: ConductedConfig): Promise<LaunchResult> {
  const args = buildArgs(config);

  // Ensure log directory exists
  const logDir = join(workLogsDir(config.workDir), config.agentId);
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `${config.taskId}.jsonl`);
  const logStream = createWriteStream(logPath, { flags: 'a' });

  const child = spawn('claude', args, {
    cwd: config.workDir,
    // stdout piped so we can capture stream-json lines
    // stderr inherited so Claude's progress output reaches the terminal
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let sessionId: string | null = null;

  // Process stream-json output line by line in realtime
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line: string) => {
    // Write every line to the JSONL log immediately
    logStream.write(line + '\n');
    try {
      const event = JSON.parse(line) as StreamEvent;
      // Capture session_id from any event that carries it (typically result or init)
      if (event.session_id) {
        sessionId = event.session_id;
      }
    } catch {
      // Non-JSON line — still logged, just can't parse
    }
  });

  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      logStream.end();
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      logStream.end();
      resolve({ exitCode: code ?? 1, sessionId });
    });
  });
}
