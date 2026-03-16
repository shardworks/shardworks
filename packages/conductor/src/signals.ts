import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

export function signalFilePath(workDir: string): string {
  return join(workDir, 'data', 'conductor-signals.jsonl');
}

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

export interface RateLimitSignal {
  type: 'rate_limited';
  ts: string;
  task_id: string;
  agent_id: string;
  session_id: string | null;
  retry_after: string | null;
  cost_usd: number;
}

export interface CrashedSignal {
  type: 'crashed';
  ts: string;
  task_id: string;
  agent_id: string;
  session_id: string | null;
  exit_code: number;
  cost_usd: number;
}

export type WorkerSignal = RateLimitSignal | CrashedSignal;

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

  if (fileSize <= offset) {
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
