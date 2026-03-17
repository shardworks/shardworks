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
  /** PID of the worker Node.js process (parent of Claude). */
  worker_pid: number;
  /** PID of the spawned Claude child process. */
  claude_pid: number;
}

/** Captured from the final "result" event in Claude's stream-json output. */
export interface ResultInfo {
  /** Whether the result event had is_error=true. */
  isError: boolean;
  /** The result text (e.g. error message or summary). */
  resultText: string;
  /** Total cost in USD from the result event. */
  costUsd: number;
  /** True if the result looks like a rate limit. */
  isRateLimit: boolean;
  /** ISO timestamp when the rate limit resets, if parseable. */
  retryAfter: string | null;
}

export interface LaunchResult {
  exitCode: number;
  sessionId: string | null;
  /** Info from the final "result" event, or null if Claude never emitted one. */
  result: ResultInfo | null;
  /** Commit hash from `tq session-start`, recorded before Claude was spawned.
   *  Use with `tq diff <startCommitHash> <endCommitHash>` to see every DB
   *  change made during this agent session. */
  startCommitHash: string | null;
}

/** Returned by launch() so the caller can await metadata early and done later. */
export interface LaunchHandle {
  /** Resolves as soon as session_id is captured from Claude's first events. */
  metadata: Promise<WorkerMetadata>;
  /** Resolves when Claude exits. */
  done: Promise<LaunchResult>;
}

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERNS = [
  /hit your limit/i,
  /rate.limit/i,
  /resets \d/i,
  /too many requests/i,
];

export function detectRateLimit(event: StreamEvent): boolean {
  if (!event.is_error) return false;
  if ((event.total_cost_usd ?? 0) > 0) return false;
  const text = event.result ?? '';
  return RATE_LIMIT_PATTERNS.some(p => p.test(text));
}

/**
 * Try to parse a "resets <time>" from a rate-limit message.
 * Returns an ISO timestamp or null.
 */
export function parseRetryAfter(message: string): string | null {
  // Match patterns like "resets 5pm (UTC)" or "resets 17:00 (UTC)"
  const match = message.match(/resets\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*\((\w+)\)/i);
  if (!match) return null;
  try {
    const timeStr = match[1]!.trim();
    const tz = match[2]!;
    // Simple parse: assume today's date with the given time
    const now = new Date();
    let hours: number;
    let minutes = 0;
    const timeParts = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!timeParts) return null;
    hours = parseInt(timeParts[1]!, 10);
    if (timeParts[2]) minutes = parseInt(timeParts[2], 10);
    if (timeParts[3]) {
      const period = timeParts[3].toLowerCase();
      if (period === 'pm' && hours < 12) hours += 12;
      if (period === 'am' && hours === 12) hours = 0;
    }
    // Assume UTC if tz matches
    if (tz.toUpperCase() === 'UTC') {
      const retry = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes));
      if (retry <= now) retry.setUTCDate(retry.getUTCDate() + 1);
      return retry.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Log directory
// ---------------------------------------------------------------------------

export function workLogsDir(workDir: string): string {
  return process.env['WORK_LOGS_DIR'] ?? join(workDir, 'data', 'work-logs');
}

// ---------------------------------------------------------------------------
// Heartbeat helpers
// ---------------------------------------------------------------------------

/**
 * Fetch timeout_seconds for a task via `tq show`.
 * Returns null if the task has no timeout or if the command fails.
 */
async function fetchTimeoutSeconds(taskId: string, workDir: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('tq', ['show', taskId], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) { resolve(null); return; }
      try {
        const task = JSON.parse(out.trim()) as { timeout_seconds?: number | null };
        resolve(task.timeout_seconds ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Start a heartbeat loop that calls `tq heartbeat <taskId> --agent <agentId>`
 * every intervalMs. Returns a cleanup function that clears the interval.
 * Heartbeat errors are logged as warnings and never crash the launcher.
 */
function startHeartbeatLoop(
  taskId: string,
  agentId: string,
  workDir: string,
  intervalMs: number,
): () => void {
  const handle = setInterval(() => {
    const hb = spawn('tq', ['heartbeat', taskId, '--agent', agentId], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    hb.stdout.on('data', (chunk: Buffer) => { out += chunk; });
    hb.stderr.on('data', (chunk: Buffer) => { err += chunk; });
    hb.on('error', (e) => {
      process.stderr.write(`[heartbeat] warning: failed to spawn tq heartbeat: ${e.message}\n`);
    });
    hb.on('close', (code) => {
      if (code !== 0) {
        process.stderr.write(
          `[heartbeat] warning: tq heartbeat exited ${code}: ${(err || out).trim()}\n`,
        );
      }
    });
  }, intervalMs);

  return () => clearInterval(handle);
}

// ---------------------------------------------------------------------------
// Session bracket helpers
// ---------------------------------------------------------------------------

/**
 * Call `tq session-start --agent <agentId>` and return the Dolt commit hash.
 * Returns null on any error (errors are logged as warnings, never fatal).
 */
async function runTqSessionStart(agentId: string, workDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('tq', ['session-start', '--agent', agentId], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk; });
    child.on('error', (e) => {
      process.stderr.write(`[session] warning: failed to spawn tq session-start: ${e.message}\n`);
      resolve(null);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        process.stderr.write(
          `[session] warning: tq session-start exited ${code}: ${(err || out).trim()}\n`,
        );
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(out.trim()) as { commit_hash?: string };
        resolve(data.commit_hash ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Call `tq session-end --agent <agentId>`.
 * Errors are logged as warnings and never propagated.
 */
async function runTqSessionEnd(agentId: string, workDir: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('tq', ['session-end', '--agent', agentId], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk; });
    child.on('error', (e) => {
      process.stderr.write(`[session] warning: failed to spawn tq session-end: ${e.message}\n`);
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        process.stderr.write(
          `[session] warning: tq session-end exited ${code}: ${(err || out).trim()}\n`,
        );
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

export function buildArgs(config: ConductedConfig): { args: string[]; prompt: string } {
  const role = loadRole(config.role, config.workDir);
  const vars = { agentId: config.agentId, taskId: config.taskId, agentTags: config.agentTags, workDir: config.workDir, branch: config.branch };

  const args: string[] = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--model', role.model ?? config.claudeModel,
    '--system-prompt', renderSystemPrompt(role, vars),
  ];

  // Restrict to role-specific tool set when configured; reduces tool definition
  // tokens and prevents unintended tool use (e.g. refiner shouldn't edit files).
  if (role.allowedTools && role.allowedTools.length > 0) {
    args.push('--tools', role.allowedTools.join(','));
  }

  // Worktree is keyed by task ID — survives across agent invocations.
  // Skip for roles that have no file-editing tools (Write/Edit): they only
  // need tq commands and don't benefit from a git worktree checkout.
  const needsWorktree =
    !role.allowedTools ||
    role.allowedTools.includes('Write') ||
    role.allowedTools.includes('Edit');
  if (needsWorktree) {
    args.push('--worktree', config.taskId);
  }

  if (config.claudeMaxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(config.claudeMaxBudgetUsd));
  }

  // The prompt is returned separately and piped to stdin in launch() because
  // --tools <tools...> is variadic and greedily consumes positional args.
  const prompt = renderWorkPrompt(role, vars);

  return { args, prompt };
}

// ---------------------------------------------------------------------------
// Human-readable stderr formatter
// ---------------------------------------------------------------------------

type ContentBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; content?: string; is_error?: boolean };

/** Returns a short hint string for the most relevant field in a tool's input. */
function formatToolInput(input: Record<string, unknown>): string {
  const hint =
    input['command'] ??
    input['cmd'] ??
    input['pattern'] ??
    input['query'] ??
    input['path'] ??
    input['file_path'];
  if (hint === undefined) return '';
  // Trim to first line so Bash heredocs don't flood the output
  const first = String(hint).split('\n')[0]!;
  return first.length > 120 ? `: ${first.slice(0, 120)}…` : `: ${first}`;
}

/**
 * Formats a single Claude stream-json event into a human-readable string for
 * stderr output. Returns null for event types that need no display.
 *
 * Claude CLI emits complete message objects (not streaming deltas) where all
 * content is in event.message.content[].
 */
export function formatEvent(event: StreamEvent): string | null {
  // Assistant turn: thinking blocks, text blocks, tool-use calls
  if (event.type === 'assistant') {
    const content = (event.message as { content?: ContentBlock[] } | undefined)?.content;
    if (!content?.length) return null;

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'thinking' && block.thinking) {
        parts.push(`[thinking] ${block.thinking}`);
      } else if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (block.type === 'tool_use' && block.name) {
        const hint = block.input ? formatToolInput(block.input) : '';
        parts.push(`[tool] ${block.name}${hint}`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  // User turn: tool results
  if (event.type === 'user') {
    const content = (event.message as { content?: ContentBlock[] } | undefined)?.content;
    if (!content?.length) return null;

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'tool_result') {
        const output = String(block.content ?? '');
        const truncated = output.length > 300 ? output.slice(0, 300) + '…' : output;
        const errFlag = block.is_error ? ' [error]' : '';
        parts.push(`[result${errFlag}] ${truncated}`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
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
  const { args, prompt } = buildArgs(config);

  // Logs are keyed by task ID (not agent ID) — append across retries
  const logDir = workLogsDir(config.workDir);
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

    // Record a Dolt commit bracket before spawning Claude so operators can
    // later run `tq diff <startCommitHash> <endCommitHash>` to inspect all
    // DB mutations made during this agent session.
    const startCommitHash = await runTqSessionStart(config.agentId, config.workDir);

    const child = spawn('claude', args, {
      cwd: config.workDir,
      // Pipe stdin (prompt), stdout (stream-json), and stderr (Claude's progress output)
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write the prompt via stdin to avoid --tools variadic arg consuming it
    child.stdin!.end(prompt);

    // Start heartbeat loop if the task has a timeout configured.
    // Use half the timeout as the heartbeat interval so we comfortably beat
    // the deadline. Errors are warnings — they never crash the launcher.
    const timeoutSec = await fetchTimeoutSeconds(config.taskId, config.workDir);
    let stopHeartbeat: (() => void) | null = null;
    if (timeoutSec !== null && timeoutSec > 0) {
      const intervalMs = Math.floor(timeoutSec * 500); // half of timeout in ms
      stopHeartbeat = startHeartbeatLoop(config.taskId, config.agentId, config.workDir, intervalMs);
    }

    let sessionId: string | null = null;
    let metadataEmitted = false;
    let resultInfo: ResultInfo | null = null;

    function emitMetadata(sid: string): void {
      if (metadataEmitted) return;
      metadataEmitted = true;
      resolveMetadata!({
        agent_id: config.agentId,
        task_id: config.taskId,
        role: config.role,
        session_id: sid,
        log_path: logPath,
        worker_pid: process.pid,
        claude_pid: child.pid ?? -1,
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

        // Capture the final result event for rate-limit detection
        if (event.type === 'result') {
          const isRL = detectRateLimit(event);
          resultInfo = {
            isError: event.is_error ?? false,
            resultText: event.result ?? '',
            costUsd: event.total_cost_usd ?? 0,
            isRateLimit: isRL,
            retryAfter: isRL ? parseRetryAfter(event.result ?? '') : null,
          };
        }

        // In interactive mode, format events to stderr
        if (config.interactive) {
          const formatted = formatEvent(event);
          if (formatted !== null) {
            process.stderr.write(formatted + '\n');
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
      // Guard against double-settlement if both 'error' and 'close' fire for
      // the same spawn failure (error fires first, then close follows).
      let settled = false;

      child.on('error', (err) => {
        stopHeartbeat?.();
        void runTqSessionEnd(config.agentId, config.workDir).then(() => {
          if (settled) return;
          settled = true;
          logStream.end();
          // If metadata wasn't emitted yet, reject that promise too
          if (!metadataEmitted) {
            metadataEmitted = true;
            rejectMetadata!(new Error(`Failed to spawn claude: ${err.message}`));
          }
          reject(new Error(`Failed to spawn claude: ${err.message}`));
        });
      });

      child.on('close', (code) => {
        stopHeartbeat?.();
        void runTqSessionEnd(config.agentId, config.workDir).then(() => {
          if (settled) return;
          settled = true;
          logStream.end();
          // If session_id never appeared (e.g. Claude crashed immediately),
          // still resolve metadata with empty session_id so the caller doesn't hang
          if (!metadataEmitted) {
            emitMetadata('');
          }
          resolve({ exitCode: code ?? 1, sessionId, result: resultInfo, startCommitHash });
        });
      });
    });
  })();

  return { metadata, done };
}
