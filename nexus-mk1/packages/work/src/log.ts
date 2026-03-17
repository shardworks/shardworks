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

/** A single content block within an assistant or user message. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown }
  | { type: 'thinking'; thinking?: string }
  | { type: string; [key: string]: unknown };

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: ContentBlock[];
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip curly braces from content so blessed doesn't interpret them as tags. */
function esc(s: string): string {
  return s.replace(/[{}]/g, '');
}

/**
 * Summarize a tool's input object into a short human-readable string.
 * Extracts the most meaningful field(s) per tool name.
 */
function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;

  // Strip MCP namespace prefix (e.g. "mcp__bash__bash" → "bash")
  const toolBase = name.split('__').pop()?.toLowerCase() ?? name.toLowerCase();

  switch (toolBase) {
    case 'bash': {
      const cmd = String(inp['command'] ?? inp['cmd'] ?? '');
      return cmd.slice(0, 120);
    }
    case 'read': {
      const fp = String(inp['file_path'] ?? inp['path'] ?? '');
      const offset = inp['offset'] != null ? `:${inp['offset']}` : '';
      return `${fp}${offset}`;
    }
    case 'write': {
      return String(inp['file_path'] ?? inp['path'] ?? '');
    }
    case 'edit': {
      return String(inp['file_path'] ?? inp['path'] ?? '');
    }
    case 'grep': {
      const pat = String(inp['pattern'] ?? '');
      const path = inp['path'] ? ` in ${String(inp['path'])}` : '';
      const glob = inp['glob'] ? ` [${String(inp['glob'])}]` : '';
      return `/${pat}/${path}${glob}`;
    }
    case 'glob': {
      const pat = String(inp['pattern'] ?? '');
      const path = inp['path'] ? ` in ${String(inp['path'])}` : '';
      return `${pat}${path}`;
    }
    case 'task': {
      // Agent sub-task
      const desc = String(inp['description'] ?? inp['prompt'] ?? '');
      return desc.slice(0, 100);
    }
    default: {
      // Generic: show first 1-2 key=value pairs
      const keys = Object.keys(inp);
      if (keys.length === 0) return '';
      const firstKey = keys[0]!;
      const firstVal = String(inp[firstKey] ?? '').replace(/\n/g, '↵').slice(0, 80);
      if (keys.length > 1) {
        const secondKey = keys[1]!;
        const secondVal = String(inp[secondKey] ?? '').replace(/\n/g, '↵').slice(0, 40);
        return `${firstKey}=${firstVal} ${secondKey}=${secondVal}`;
      }
      return `${firstKey}=${firstVal}`;
    }
  }
}

/**
 * Extract a short preview from a tool_result content value.
 * Content may be a string, an array of blocks, or an object.
 */
function extractToolResultPreview(content: unknown, maxLen = 120): string {
  if (content == null) return '';
  if (typeof content === 'string') {
    return content.replace(/\n/g, '↵').slice(0, maxLen);
  }
  if (Array.isArray(content)) {
    // Array of content blocks — find the first text block
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          return b['text'].replace(/\n/g, '↵').slice(0, maxLen);
        }
      }
    }
  }
  if (typeof content === 'object') {
    return JSON.stringify(content).slice(0, maxLen);
  }
  return String(content).slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Compact formatter (blessed markup) — used in the inline Worker Log panel
// ---------------------------------------------------------------------------

/**
 * Format a stream event into a short human-readable line with blessed markup.
 * Returns null for events that should be silently skipped.
 */
export function formatEvent(event: StreamEvent): string | null {
  // Timestamp prefix (Claude SDK events may not carry one)
  const ts = event.timestamp
    ? new Date(event.timestamp as string).toLocaleTimeString()
    : '';
  const prefix = ts ? `{grey-fg}${ts}{/grey-fg} ` : '';

  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content ?? [];
      const lines: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text') {
          const text = esc(String(b['text'] ?? '').replace(/\n/g, ' ').slice(0, 200));
          if (text.trim()) {
            lines.push(`${prefix}{green-fg}[assistant]{/green-fg} ${text}`);
          }
        } else if (b['type'] === 'tool_use') {
          const name = String(b['name'] ?? '');
          const summary = esc(summarizeToolInput(name, b['input']));
          const summaryPart = summary ? ` {grey-fg}${summary}{/grey-fg}` : '';
          lines.push(`${prefix}{yellow-fg}[tool]{/yellow-fg} {bold}${esc(name)}{/bold}${summaryPart}`);
        } else if (b['type'] === 'thinking') {
          const snippet = esc(String(b['thinking'] ?? '').replace(/\n/g, ' ').slice(0, 100));
          if (snippet.trim()) {
            lines.push(`${prefix}{grey-fg}[think]{/grey-fg} {grey-fg}${snippet}…{/grey-fg}`);
          }
        }
      }
      // Legacy streaming format fallback
      if (lines.length === 0) {
        if (event.subtype === 'text' && event.content_block?.text) {
          const text = esc((event.content_block.text as string).slice(0, 200));
          if (text.trim()) {
            lines.push(`${prefix}{green-fg}[assistant]{/green-fg} ${text}`);
          }
        } else if (event.content_block?.name) {
          lines.push(`${prefix}{yellow-fg}[tool]{/yellow-fg} {bold}${esc(String(event.content_block.name))}{/bold}`);
        }
      }
      return lines.length > 0 ? lines.join('\n') : null;
    }

    case 'user': {
      // Tool results come back as user messages in the SDK format
      const content = event.message?.content ?? [];
      const resultBlocks = content.filter(b => b.type === 'tool_result') as Array<{ type: 'tool_result'; tool_use_id?: string; content?: unknown }>;
      if (resultBlocks.length === 0) return null;

      const lines: string[] = [];
      for (const rb of resultBlocks) {
        const preview = esc(extractToolResultPreview(rb.content));
        const previewPart = preview ? ` {grey-fg}${preview}{/grey-fg}` : '';
        lines.push(`${prefix}{cyan-fg}[result]{/cyan-fg}${previewPart}`);
      }
      return lines.join('\n');
    }

    // Legacy streaming event types
    case 'tool_use': {
      const name = event.content_block?.name ?? 'unknown';
      return `${prefix}{yellow-fg}[tool]{/yellow-fg} {bold}${esc(String(name))}{/bold}`;
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

// ---------------------------------------------------------------------------
// Verbose formatter (blessed markup) — used in the full-screen log overlay
// ---------------------------------------------------------------------------

/**
 * Format a tool input object as a multi-line indented string for the overlay.
 * Returns an array of lines (without timestamp prefix).
 */
function formatToolInputVerbose(name: string, input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const inp = input as Record<string, unknown>;
  const toolBase = name.split('__').pop()?.toLowerCase() ?? name.toLowerCase();
  const lines: string[] = [];

  // For bash, show the full command
  if (toolBase === 'bash') {
    const cmd = String(inp['command'] ?? inp['cmd'] ?? '');
    if (cmd) {
      for (const cmdLine of cmd.split('\n')) {
        lines.push(`  {grey-fg}$ {/grey-fg}${esc(cmdLine)}`);
      }
    }
    return lines;
  }

  // For file ops, show path and optionally first content lines
  if (['read', 'write', 'edit'].includes(toolBase)) {
    const fp = String(inp['file_path'] ?? inp['path'] ?? '');
    if (fp) lines.push(`  {grey-fg}file:{/grey-fg} ${esc(fp)}`);
    if (toolBase === 'edit') {
      const oldStr = String(inp['old_string'] ?? '').slice(0, 80).replace(/\n/g, '↵');
      const newStr = String(inp['new_string'] ?? '').slice(0, 80).replace(/\n/g, '↵');
      if (oldStr) lines.push(`  {grey-fg}old:{/grey-fg}  ${esc(oldStr)}${oldStr.length >= 80 ? '…' : ''}`);
      if (newStr) lines.push(`  {grey-fg}new:{/grey-fg}  ${esc(newStr)}${newStr.length >= 80 ? '…' : ''}`);
    }
    if (toolBase === 'read') {
      if (inp['offset'] != null) lines.push(`  {grey-fg}offset:{/grey-fg} ${inp['offset']}`);
      if (inp['limit'] != null) lines.push(`  {grey-fg}limit:{/grey-fg}  ${inp['limit']}`);
    }
    return lines;
  }

  if (toolBase === 'grep') {
    const pat = String(inp['pattern'] ?? '');
    if (pat) lines.push(`  {grey-fg}pattern:{/grey-fg} ${esc(pat)}`);
    if (inp['path']) lines.push(`  {grey-fg}path:{/grey-fg}    ${esc(String(inp['path']))}`);
    if (inp['glob']) lines.push(`  {grey-fg}glob:{/grey-fg}    ${esc(String(inp['glob']))}`);
    return lines;
  }

  if (toolBase === 'glob') {
    const pat = String(inp['pattern'] ?? '');
    if (pat) lines.push(`  {grey-fg}pattern:{/grey-fg} ${esc(pat)}`);
    if (inp['path']) lines.push(`  {grey-fg}path:{/grey-fg}    ${esc(String(inp['path']))}`);
    return lines;
  }

  // Generic: show all keys
  for (const [k, v] of Object.entries(inp)) {
    const valStr = typeof v === 'string'
      ? v.slice(0, 200).replace(/\n/g, '↵')
      : JSON.stringify(v).slice(0, 200);
    lines.push(`  {grey-fg}${esc(k)}:{/grey-fg} ${esc(valStr)}${valStr.length >= 200 ? '…' : ''}`);
  }
  return lines;
}

/**
 * Format a stream event into a verbose multi-line string with blessed markup.
 * Used for the full-screen log overlay where more detail is useful.
 * Returns null for events that should be silently skipped.
 */
export function formatEventVerbose(event: StreamEvent): string | null {
  const ts = event.timestamp
    ? new Date(event.timestamp as string).toLocaleTimeString()
    : '';
  const prefix = ts ? `{grey-fg}${ts}{/grey-fg} ` : '';

  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content ?? [];
      const parts: string[] = [];

      for (const block of content) {
        if (block.type === 'text' && 'text' in block) {
          const textBlock = block as { type: 'text'; text: string };
          const trimmed = textBlock.text.trim();
          if (!trimmed) continue;
          // Show each paragraph line, preserving breaks, wrapping long lines
          parts.push(`${prefix}{green-fg}[assistant]{/green-fg}`);
          for (const line of trimmed.split('\n')) {
            parts.push(`  ${esc(line)}`);
          }
        } else if (block.type === 'tool_use' && 'name' in block) {
          const toolBlock = block as { type: 'tool_use'; name: string; input: unknown };
          parts.push(`${prefix}{yellow-fg}[tool]{/yellow-fg} {bold}${esc(toolBlock.name)}{/bold}`);
          const inputLines = formatToolInputVerbose(toolBlock.name, toolBlock.input);
          parts.push(...inputLines);
        } else if (block.type === 'thinking' && 'thinking' in block) {
          const thinkBlock = block as { type: 'thinking'; thinking?: string };
          const thinking = (thinkBlock.thinking ?? '').trim();
          if (!thinking) continue;
          // Show up to 300 chars of thinking content, truncated
          const snippet = thinking.slice(0, 300).replace(/\n/g, ' ');
          const truncated = thinking.length > 300 ? snippet + '…' : snippet;
          parts.push(`${prefix}{grey-fg}[thinking]{/grey-fg} {grey-fg}${esc(truncated)}{/grey-fg}`);
        }
      }

      // Legacy streaming format fallback
      if (parts.length === 0) {
        if (event.subtype === 'text' && event.content_block?.text) {
          const text = (event.content_block.text as string).trim();
          if (text) {
            parts.push(`${prefix}{green-fg}[assistant]{/green-fg}`);
            for (const line of text.split('\n')) {
              parts.push(`  ${esc(line)}`);
            }
          }
        } else if (event.content_block?.name) {
          parts.push(`${prefix}{yellow-fg}[tool]{/yellow-fg} {bold}${esc(String(event.content_block.name))}{/bold}`);
        }
      }
      return parts.length > 0 ? parts.join('\n') : null;
    }

    case 'user': {
      const content = event.message?.content ?? [];
      const resultBlocks = content.filter(b => b.type === 'tool_result') as Array<{ type: 'tool_result'; tool_use_id?: string; content?: unknown }>;
      if (resultBlocks.length === 0) return null;

      const parts: string[] = [];
      for (const rb of resultBlocks) {
        parts.push(`${prefix}{cyan-fg}[result]{/cyan-fg}`);
        // Show up to 400 chars of result content
        const preview = extractToolResultPreview(rb.content, 400);
        if (preview) {
          for (const line of preview.split('↵').slice(0, 8)) {
            parts.push(`  {grey-fg}${esc(line)}{/grey-fg}`);
          }
          if (typeof rb.content === 'string' && rb.content.length > 400) {
            parts.push(`  {grey-fg}… (${rb.content.length} chars total){/grey-fg}`);
          }
        }
      }
      return parts.join('\n');
    }

    // Legacy streaming event types
    case 'tool_use': {
      const name = event.content_block?.name ?? 'unknown';
      return `${prefix}{yellow-fg}[tool]{/yellow-fg} {bold}${esc(String(name))}{/bold}`;
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

// ---------------------------------------------------------------------------
// Plain-text formatter (no blessed markup) — for non-TUI contexts
// ---------------------------------------------------------------------------

/** Format a stream event as plain text (no blessed markup). */
export function formatEventPlain(event: StreamEvent): string | null {
  const ts = event.timestamp
    ? new Date(event.timestamp as string).toLocaleTimeString()
    : '';
  const prefix = ts ? `${ts} ` : '';

  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content ?? [];
      const lines: string[] = [];
      for (const block of content) {
        if (block.type === 'text' && 'text' in block) {
          const textBlock = block as { type: 'text'; text: string };
          const text = textBlock.text.replace(/\n/g, ' ').slice(0, 200);
          if (text.trim()) lines.push(`${prefix}[assistant] ${text}`);
        } else if (block.type === 'tool_use' && 'name' in block) {
          const toolBlock = block as { type: 'tool_use'; name: string; input: unknown };
          const summary = summarizeToolInput(toolBlock.name, toolBlock.input);
          lines.push(`${prefix}[tool] ${toolBlock.name}${summary ? ' ' + summary : ''}`);
        } else if (block.type === 'thinking' && 'thinking' in block) {
          const thinkBlock = block as { type: 'thinking'; thinking?: string };
          const snippet = (thinkBlock.thinking ?? '').replace(/\n/g, ' ').slice(0, 100);
          if (snippet.trim()) lines.push(`${prefix}[think] ${snippet}…`);
        }
      }
      // Legacy streaming format fallback
      if (lines.length === 0) {
        if (event.subtype === 'text' && event.content_block?.text) {
          const text = (event.content_block.text as string).slice(0, 200);
          if (text.trim()) lines.push(`${prefix}[assistant] ${text}`);
        } else if (event.content_block?.name) {
          lines.push(`${prefix}[tool] ${event.content_block.name}`);
        }
      }
      return lines.length > 0 ? lines.join('\n') : null;
    }
    case 'user': {
      const content = event.message?.content ?? [];
      const resultBlocks = content.filter(b => b.type === 'tool_result');
      if (resultBlocks.length === 0) return null;
      const lines: string[] = [];
      for (const rb of resultBlocks) {
        const toolResultBlock = rb as { type: 'tool_result'; content?: unknown };
        const preview = extractToolResultPreview(toolResultBlock.content);
        lines.push(`${prefix}[result]${preview ? ' ' + preview : ''}`);
      }
      return lines.join('\n');
    }
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
