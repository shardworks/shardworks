import { createReadStream, existsSync, watchFile, unwatchFile } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { workerLogFiles, formatEventPlain, type StreamEvent } from './log.js';

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

  // Watch for new data
  const poll = setInterval(async () => {
    try {
      const s = await stat(logPath);
      if (s.size > offset) {
        await printLines(logPath, offset);
        offset = s.size;
      }
    } catch {
      // File may not exist yet — keep waiting
    }
  }, 250);

  // Also use fs.watchFile as a fallback for immediate notification
  watchFile(logPath, { interval: 500 }, async (curr) => {
    if (curr.size > offset) {
      await printLines(logPath, offset);
      offset = curr.size;
    }
  });

  // Keep alive until Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(poll);
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
 * - If it looks like a worker UUID, find the latest log in that worker's dir.
 * - If it looks like a task ID (tq-...), search all worker dirs.
 */
async function resolveLogPath(id: string): Promise<string | null> {
  // Try as worker ID first — find latest log
  const workerFiles = await workerLogFiles(id);
  if (workerFiles.length > 0) return workerFiles[0]!;

  // Try as task ID — search all workers for a matching file
  if (id.startsWith('tq-')) {
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { workLogsDir } = await import('./log.js');
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
  }

  return null;
}
