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
  // Content fields vary by event type
  content?: string;
  content_block?: { type: string; text?: string; thinking?: string; name?: string; input?: unknown };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Metadata emitted to stdout as soon as the session is established. */
export interface WorkerMetadata {
  agent_id: string;
  task_id: string;
  role: string;
  session_id: string;
  log_path: string;
  pid: number;
}

export interface LaunchResult {
  exitCode: number;
  sessionId: string | null;
}

/** Returned by launch() so the caller can await metadata early and done later. */
export interface LaunchHandle {
  /** Resolves as soon as session_id is captured from Claude's first events. */
  metadata: Promise<WorkerMetadata>;
  /** Resolves when Claude exits. */
  done: Promise<LaunchResult>;
}

// ---------------------------------------------------------------------------
// Log directory
// ---------------------------------------------------------------------------

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
    args.push('--resume', config.resumeSession);
  } else {
    args.push('--worktree', config.agentId);
  }

  if (config.claudeMaxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(config.claudeMaxBudgetUsd));
  }

  args.push(renderWorkPrompt(role, vars));

  return args;
}

// ---------------------------------------------------------------------------
// Human-readable stderr formatter
// ---------------------------------------------------------------------------

function formatEvent(event: StreamEvent): string | null {
  // Content block delta events (streaming tokens)
  if (event.type === 'content_block_delta') {
    const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined;
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      return `[thinking] ${delta.thinking}`;
    }
    if (delta?.type === 'text_delta' && delta.text) {
      return delta.text;
    }
    return null;
  }

  // Content block start (tool use)
  if (event.type === 'content_block_start') {
    const block = event.content_block;
    if (block?.type === 'tool_use' && block.name) {
      return `\n[tool] ${block.name}`;
    }
    return null;
  }

  // Assistant message events (non-streaming)
  if (event.type === 'assistant') {
    if (event.subtype === 'thinking' && event.content) {
      return `[thinking] ${event.content}`;
    }
    if (event.subtype === 'text' && event.content) {
      return event.content;
    }
    if (event.subtype === 'tool_use') {
      const name = (event as Record<string, unknown>).name ?? (event as Record<string, unknown>).tool_name ?? 'unknown';
      return `\n[tool] ${name}`;
    }
    return null;
  }

  // Tool results
  if (event.type === 'tool' && event.subtype === 'result') {
    const name = (event as Record<string, unknown>).name ?? (event as Record<string, unknown>).tool_name ?? 'tool';
    const output = String(event.content ?? '');
    const truncated = output.length > 200 ? output.slice(0, 200) + '...' : output;
    return `[result] ${name}: ${truncated}`;
  }

  // Final result
  if (event.type === 'result') {
    const cost = event.total_cost_usd;
    const costStr = cost !== undefined ? ` cost=$${cost.toFixed(4)}` : '';
    return `\n[done]${costStr}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export function launch(config: ConductedConfig): LaunchHandle {
  const args = buildArgs(config);
  const logDir = join(workLogsDir(config.workDir), config.agentId);
  const logPath = join(logDir, `${config.taskId}.jsonl`);

  let resolveMetadata: (meta: WorkerMetadata) => void;
  let rejectMetadata: (err: Error) => void;
  const metadata = new Promise<WorkerMetadata>((resolve, reject) => {
    resolveMetadata = resolve;
    rejectMetadata = reject;
  });

  const done = (async (): Promise<LaunchResult> => {
    await mkdir(logDir, { recursive: true });
    const logStream = createWriteStream(logPath, { flags: 'a' });

    const child = spawn('claude', args, {
      cwd: config.workDir,
      // Pipe both stdout (stream-json) and stderr (Claude's progress output)
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let sessionId: string | null = null;
    let metadataEmitted = false;

    function emitMetadata(sid: string): void {
      if (metadataEmitted) return;
      metadataEmitted = true;
      resolveMetadata!({
        agent_id: config.agentId,
        task_id: config.taskId,
        role: config.role,
        session_id: sid,
        log_path: logPath,
        pid: process.pid,
      });
    }

    // Process stream-json (Claude's stdout)
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line: string) => {
      logStream.write(line + '\n');
      try {
        const event = JSON.parse(line) as StreamEvent;

        // Capture session_id as soon as it appears
        if (event.session_id && !sessionId) {
          sessionId = event.session_id;
          emitMetadata(sessionId);
        }

        // In interactive mode, format events to stderr
        if (config.interactive) {
          const formatted = formatEvent(event);
          if (formatted !== null) {
            process.stderr.write(formatted);
            // Add newline for block-level events, not for streaming deltas
            if (event.type !== 'content_block_delta') {
              process.stderr.write('\n');
            }
          }
        }
      } catch {
        // Non-JSON line — still logged, skip formatting
      }
    });

    // Discard Claude's stderr (progress spinners, etc.)
    // In interactive mode we have our own formatted output from stream-json
    child.stderr.resume();

    return new Promise<LaunchResult>((resolve, reject) => {
      child.on('error', (err) => {
        logStream.end();
        // If metadata wasn't emitted yet, reject that promise too
        if (!metadataEmitted) {
          metadataEmitted = true;
          rejectMetadata!(new Error(`Failed to spawn claude: ${err.message}`));
        }
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      child.on('close', (code) => {
        logStream.end();
        // If session_id never appeared (e.g. Claude crashed immediately),
        // still resolve metadata with empty session_id so the caller doesn't hang
        if (!metadataEmitted) {
          emitMetadata('');
        }
        resolve({ exitCode: code ?? 1, sessionId });
      });
    });
  })();

  return { metadata, done };
}
