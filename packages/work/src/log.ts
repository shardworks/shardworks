import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';

/** Base directory for work logs. */
export function workLogsDir(): string {
  return process.env['WORK_LOGS_DIR'] ?? join(process.cwd(), 'data', 'work-logs');
}

/**
 * Return the log file path for a task.
 * New layout: data/work-logs/<task-id>.jsonl (flat, keyed by task ID).
 */
export function taskLogPath(taskId: string): string {
  return join(workLogsDir(), `${taskId}.jsonl`);
}

/**
 * Return the log file path for a specific worker + task.
 * @deprecated Use taskLogPath() — this is the old nested layout for backward compat.
 */
export function logFilePath(workerId: string, taskId: string): string {
  return join(workLogsDir(), workerId, `${taskId}.jsonl`);
}

/** Find all log files for a given worker, sorted by mtime descending (latest first). */
export async function workerLogFiles(workerId: string): Promise<string[]> {
  const dir = join(workLogsDir(), workerId);
  try {
    const entries = await readdir(dir);
    const files = entries.filter(e => e.endsWith('.jsonl'));
    // Sort by modification time, newest first
    const withStats = await Promise.all(
      files.map(async f => {
        const path = join(dir, f);
        const s = await stat(path);
        return { path, mtime: s.mtimeMs };
      }),
    );
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats.map(w => w.path);
  } catch {
    return [];
  }
}

/**
 * Resolve a task ID to its log file path.
 * Checks the new flat layout first, then falls back to searching nested dirs.
 */
export function resolveTaskLog(taskId: string): string | null {
  // New layout: data/work-logs/<task-id>.jsonl
  const flat = taskLogPath(taskId);
  if (existsSync(flat)) return flat;
  return null;
}

/** List all worker IDs that have log directories (legacy layout). */
export async function listWorkerIds(): Promise<string[]> {
  const base = workLogsDir();
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stream event types (matches worker launcher output)
// ---------------------------------------------------------------------------

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  };
  content_block?: {
    type: string;
    text?: string;
    name?: string;
  };
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  [key: string]: unknown;
}

/** Strip curly braces from content so blessed doesn't interpret them as tags. */
function esc(s: string): string {
  return s.replace(/[{}]/g, '');
}

/** Format a stream event into a short human-readable line. */
export function formatEvent(event: StreamEvent): string | null {
  // Derive a timestamp prefix from the event if available. Claude SDK events
  // don't always carry a top-level `timestamp`; fall back to nothing.
  const ts = event.timestamp
    ? new Date(event.timestamp as string).toLocaleTimeString()
    : '';
  const prefix = ts ? `{grey-fg}${ts}{/grey-fg} ` : '';

  switch (event.type) {
    case 'assistant': {
      // Claude SDK format: event.message.content is an array of content blocks
      const content = (event.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } | undefined)?.content ?? [];
      const lines: string[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const text = esc(block.text.replace(/\n/g, ' ').slice(0, 200));
          lines.push(`${prefix}{green-fg}[assistant]{/green-fg} ${text}`);
        } else if (block.type === 'tool_use' && block.name) {
          const inputStr = block.input ? esc(JSON.stringify(block.input).slice(0, 80)) : '';
          lines.push(`${prefix}{yellow-fg}[tool]{/yellow-fg} ${esc(block.name)}${inputStr ? ' ' + inputStr : ''}`);
        }
        // 'thinking' blocks are skipped (internal reasoning)
      }
      // Legacy streaming format: event.subtype + event.content_block
      if (lines.length === 0) {
        if (event.subtype === 'text' && event.content_block?.text) {
          const text = esc((event.content_block.text as string).slice(0, 200));
          lines.push(`${prefix}{green-fg}[assistant]{/green-fg} ${text}`);
        } else if (event.content_block?.name) {
          lines.push(`${prefix}{yellow-fg}[tool]{/yellow-fg} ${esc(String(event.content_block.name))}`);
        }
      }
      return lines.length > 0 ? lines.join('\n') : null;
    }
    case 'user': {
      // Tool results come back as user messages in the SDK format
      const content = (event.message as { content?: Array<{ type: string; content?: unknown }> } | undefined)?.content ?? [];
      const resultCount = content.filter((b: { type: string }) => b.type === 'tool_result').length;
      if (resultCount > 0) {
        return `${prefix}{cyan-fg}[result]{/cyan-fg} ${resultCount} tool result${resultCount > 1 ? 's' : ''}`;
      }
      return null;
    }
    // Legacy streaming event types
    case 'tool_use': {
      const name = event.content_block?.name ?? 'unknown';
      return `${prefix}{yellow-fg}[tool]{/yellow-fg} ${esc(String(name))}`;
    }
    case 'tool_result': {
      return `${prefix}{cyan-fg}[result]{/cyan-fg} tool completed`;
    }
    case 'result': {
      const cost = event.total_cost_usd
        ? ` ($${(event.total_cost_usd as number).toFixed(4)})`
        : '';
      const dur = event.duration_ms
        ? ` ${((event.duration_ms as number) / 1000).toFixed(1)}s`
        : '';
      return `${prefix}{bold}{white-fg}[done]{/white-fg}{/bold}${dur}${cost}`;
    }
    case 'system': {
      if (event.subtype === 'init') {
        return `${prefix}{blue-fg}[init]{/blue-fg} session ${event.session_id ?? '?'}`;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Format a stream event as plain text (no blessed markup). */
export function formatEventPlain(event: StreamEvent): string | null {
  const ts = event.timestamp
    ? new Date(event.timestamp as string).toLocaleTimeString()
    : '';
  const prefix = ts ? `${ts} ` : '';

  switch (event.type) {
    case 'assistant': {
      // Claude SDK format: event.message.content is an array of content blocks
      const content = (event.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } | undefined)?.content ?? [];
      const lines: string[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const text = block.text.replace(/\n/g, ' ').slice(0, 200);
          lines.push(`${prefix}[assistant] ${text}`);
        } else if (block.type === 'tool_use' && block.name) {
          const inputStr = block.input ? JSON.stringify(block.input).slice(0, 80) : '';
          lines.push(`${prefix}[tool] ${block.name}${inputStr ? ' ' + inputStr : ''}`);
        }
      }
      // Legacy streaming format fallback
      if (lines.length === 0) {
        if (event.subtype === 'text' && event.content_block?.text) {
          const text = (event.content_block.text as string).slice(0, 200);
          lines.push(`${prefix}[assistant] ${text}`);
        } else if (event.content_block?.name) {
          lines.push(`${prefix}[tool] ${event.content_block.name}`);
        }
      }
      return lines.length > 0 ? lines.join('\n') : null;
    }
    case 'user': {
      const content = (event.message as { content?: Array<{ type: string }> } | undefined)?.content ?? [];
      const resultCount = content.filter((b: { type: string }) => b.type === 'tool_result').length;
      if (resultCount > 0) {
        return `${prefix}[result] ${resultCount} tool result${resultCount > 1 ? 's' : ''}`;
      }
      return null;
    }
    // Legacy streaming event types
    case 'tool_use': {
      const name = event.content_block?.name ?? 'unknown';
      return `${prefix}[tool] ${String(name)}`;
    }
    case 'tool_result': {
      return `${prefix}[result] tool completed`;
    }
    case 'result': {
      const cost = event.total_cost_usd
        ? ` ($${(event.total_cost_usd as number).toFixed(4)})`
        : '';
      const dur = event.duration_ms
        ? ` ${((event.duration_ms as number) / 1000).toFixed(1)}s`
        : '';
      return `${prefix}[done]${dur}${cost}`;
    }
    case 'system': {
      if (event.subtype === 'init') {
        return `${prefix}[init] session ${event.session_id ?? '?'}`;
      }
      return null;
    }
    default:
      return null;
  }
}
