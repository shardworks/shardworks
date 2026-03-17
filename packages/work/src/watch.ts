import { createReadStream, existsSync, watchFile, unwatchFile } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { workerLogFiles, resolveTaskLog, taskLogPath, workLogsDir, formatEventPlain, type StreamEvent } from './log.js';

/**
 * Tail a worker's latest log file (or a specific task log), printing
 * formatted events to stdout. Runs until Ctrl+C.
 *
 * @param id  Worker ID (UUID) or task ID (tq-...). If it looks like a task ID,
 *            we search all worker dirs for a matching filename.
 */
export async function watch(id: string): Promise<void> {
  const logPath = await resolveLogPath(id);
  if (!logPath) {
    process.stderr.write(`No log files found for: ${id}\n`);
    process.exit(1);
  }

  process.stderr.write(`Tailing ${logPath}\n`);
  process.stderr.write('Press Ctrl+C to stop.\n\n');

  // Read existing content
  let offset = 0;
  if (existsSync(logPath)) {
    const s = await stat(logPath);
    offset = s.size;
    // Print existing lines first
    await printLines(logPath, 0);
  }

  // Watch for new data using a single watcher with an in-flight guard to
  // prevent concurrent reads from overlapping on the shared `offset` variable.
  let reading = false;
  watchFile(logPath, { interval: 250 }, async (curr) => {
    if (curr.size <= offset || reading) return;
    reading = true;
    try {
      // Re-check offset inside the guard in case another callback fired first
      const s = await stat(logPath);
      if (s.size > offset) {
        await printLines(logPath, offset);
        offset = s.size;
      }
    } catch {
      // File may not exist yet — keep waiting
    } finally {
      reading = false;
    }
  });

  // Keep alive until Ctrl+C
  process.on('SIGINT', () => {
    unwatchFile(logPath);
    process.stderr.write('\n');
    process.exit(0);
  });

  // Prevent Node from exiting
  await new Promise(() => {});
}

/** Read and print lines from `path` starting at byte `offset`. */
async function printLines(path: string, offset: number): Promise<void> {
  return new Promise((resolve) => {
    const stream = createReadStream(path, { start: offset, encoding: 'utf8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (line: string) => {
      try {
        const event = JSON.parse(line) as StreamEvent;
        const formatted = formatEventPlain(event);
        if (formatted) {
          process.stdout.write(formatted + '\n');
        }
      } catch {
        // Raw non-JSON line
        process.stdout.write(line + '\n');
      }
    });
    rl.on('close', resolve);
  });
}

/**
 * Resolve an ID to a log file path.
 * - If it looks like a task ID (tq-...), check flat layout first, then nested.
 * - If it looks like a worker UUID, find the latest log in that worker's dir.
 */
async function resolveLogPath(id: string): Promise<string | null> {
  // Try as task ID first — new flat layout: data/work-logs/<task-id>.jsonl
  if (id.startsWith('tq-')) {
    const flat = resolveTaskLog(id);
    if (flat) return flat;

    // Fall back to nested layout: search all worker dirs
    const base = workLogsDir();
    try {
      const workers = await readdir(base, { withFileTypes: true });
      for (const w of workers) {
        if (!w.isDirectory()) continue;
        const candidate = join(base, w.name, `${id}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // logs dir doesn't exist
    }

    // Task log path for watching (may not exist yet)
    return taskLogPath(id);
  }

  // Try as worker ID — find latest log in that worker's dir (legacy layout)
  const workerFiles = await workerLogFiles(id);
  if (workerFiles.length > 0) return workerFiles[0]!;

  return null;
}
