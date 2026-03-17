import { createReadStream } from 'node:fs';
import { stat, appendFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import type { RateLimitSignal, CrashedSignal, MergeFailedSignal, SpawnRequestSignal, WorkerSignal } from '@shardworks/shared-types';

export type { RateLimitSignal, CrashedSignal, MergeFailedSignal, SpawnRequestSignal, WorkerSignal };

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

export function signalFilePath(workDir: string): string {
  return join(workDir, 'data', 'conductor-signals.jsonl');
}

// ---------------------------------------------------------------------------
// Reading new signals using a byte-offset cursor
// ---------------------------------------------------------------------------

export interface ReadResult {
  signals: WorkerSignal[];
  /** New file offset to pass on the next call. */
  newOffset: number;
}

/**
 * Read any new signal lines appended since `offset` bytes into the file.
 * Returns the parsed signals and the updated offset.
 * Safe to call concurrently with workers appending to the file.
 */
export async function readNewSignals(
  workDir: string,
  offset: number,
): Promise<ReadResult> {
  const path = signalFilePath(workDir);

  let fileSize: number;
  try {
    const s = await stat(path);
    fileSize = s.size;
  } catch {
    // File doesn't exist yet
    return { signals: [], newOffset: offset };
  }

  if (fileSize < offset) {
    // File was truncated or rotated — reset to the beginning
    console.warn(
      `[signals] Signal file truncated (fileSize=${fileSize} < offset=${offset}); resetting offset to 0`,
    );
    offset = 0;
  }

  if (fileSize === offset) {
    return { signals: [], newOffset: offset };
  }

  const signals: WorkerSignal[] = [];

  const stream = createReadStream(path, { start: offset, end: fileSize - 1 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      signals.push(JSON.parse(trimmed) as WorkerSignal);
    } catch {
      // Malformed line — skip
    }
  }

  return { signals, newOffset: fileSize };
}

// ---------------------------------------------------------------------------
// Writing a spawn_request signal
// ---------------------------------------------------------------------------

/**
 * Append a spawn_request signal to the conductor signals file.
 * Creates the data directory if it doesn't exist.
 */
export async function appendSpawnRequest(
  workDir: string,
  opts: {
    task_id?: string;
    role?: string;
    requested_by: string;
  },
): Promise<void> {
  const path = signalFilePath(workDir);
  await mkdir(dirname(path), { recursive: true });

  const signal: SpawnRequestSignal = {
    type: 'spawn_request',
    ts: new Date().toISOString(),
    requested_by: opts.requested_by,
    ...(opts.task_id !== undefined && { task_id: opts.task_id }),
    ...(opts.role !== undefined && { role: opts.role }),
  };

  await appendFile(path, JSON.stringify(signal) + '\n', 'utf8');
}
