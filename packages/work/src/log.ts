import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

/** Base directory for work logs. */
export function workLogsDir(): string {
  return process.env['WORK_LOGS_DIR'] ?? join(process.cwd(), 'data', 'work-logs');
}

/** Return the log file path for a specific worker + task. */
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

/** List all worker IDs that have log directories. */
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

/** Format a stream event into a short human-readable line. */
export function formatEvent(event: StreamEvent): string | null {
  const ts = event.timestamp
    ? new Date(event.timestamp).toLocaleTimeString()
    : '';
  const prefix = ts ? `{grey-fg}${ts}{/grey-fg} ` : '';

  switch (event.type) {
    case 'assistant': {
      if (event.subtype === 'text' && event.content_block?.text) {
        const text = event.content_block.text.slice(0, 200);
        return `${prefix}{green-fg}[assistant]{/green-fg} ${text}`;
      }
      return null;
    }
    case 'tool_use': {
      const name = event.content_block?.name ?? 'unknown';
      return `${prefix}{yellow-fg}[tool]{/yellow-fg} ${name}`;
    }
    case 'tool_result': {
      return `${prefix}{cyan-fg}[result]{/cyan-fg} tool completed`;
    }
    case 'result': {
      const cost = event.total_cost_usd
        ? ` ($${event.total_cost_usd.toFixed(4)})`
        : '';
      const dur = event.duration_ms
        ? ` ${(event.duration_ms / 1000).toFixed(1)}s`
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
    ? new Date(event.timestamp).toLocaleTimeString()
    : '';
  const prefix = ts ? `${ts} ` : '';

  switch (event.type) {
    case 'assistant': {
      if (event.subtype === 'text' && event.content_block?.text) {
        const text = event.content_block.text.slice(0, 200);
        return `${prefix}[assistant] ${text}`;
      }
      return null;
    }
    case 'tool_use': {
      const name = event.content_block?.name ?? 'unknown';
      return `${prefix}[tool] ${name}`;
    }
    case 'tool_result': {
      return `${prefix}[result] tool completed`;
    }
    case 'result': {
      const cost = event.total_cost_usd
        ? ` ($${event.total_cost_usd.toFixed(4)})`
        : '';
      const dur = event.duration_ms
        ? ` ${(event.duration_ms / 1000).toFixed(1)}s`
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
