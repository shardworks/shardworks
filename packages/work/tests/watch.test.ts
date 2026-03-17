/**
 * Unit tests for resolveLogPath from work/src/watch.ts.
 *
 * Mocks:
 *  - node:fs          (existsSync)
 *  - node:fs/promises (readdir, stat)
 *  - ../src/log.js    (workerLogFiles, resolveTaskLog, taskLogPath, workLogsDir)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Top-level mocks — vitest hoists these before any imports
// ---------------------------------------------------------------------------

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    createReadStream: vi.fn(),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    stat: vi.fn(),
    readdir: vi.fn(),
  };
});

vi.mock('../src/log.js', () => ({
  workerLogFiles: vi.fn(),
  resolveTaskLog: vi.fn(),
  taskLogPath: vi.fn(),
  workLogsDir: vi.fn(),
  formatEventPlain: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — must come after vi.mock declarations
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { workerLogFiles, resolveTaskLog, taskLogPath, workLogsDir } from '../src/log.js';
import { resolveLogPath } from '../src/watch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockExistsSync = vi.mocked(existsSync);
const mockReaddir = vi.mocked(readdir);
const mockWorkerLogFiles = vi.mocked(workerLogFiles);
const mockResolveTaskLog = vi.mocked(resolveTaskLog);
const mockTaskLogPath = vi.mocked(taskLogPath);
const mockWorkLogsDir = vi.mocked(workLogsDir);

/** Create a minimal Dirent-like object for use with readdir withFileTypes. */
function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: '',
    path: '',
  } as unknown as Dirent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: workLogsDir returns a stable path for all tests
  mockWorkLogsDir.mockReturnValue('/data/work-logs');
  // Default: taskLogPath returns a predictable fallback
  mockTaskLogPath.mockImplementation((id: string) => `/data/work-logs/${id}.jsonl`);
});

describe('resolveLogPath — task ID (tq-...)', () => {
  it('(a) returns the flat path when resolveTaskLog finds a file', async () => {
    mockResolveTaskLog.mockReturnValue('/data/work-logs/tq-abc123.jsonl');

    const result = await resolveLogPath('tq-abc123');

    expect(result).toBe('/data/work-logs/tq-abc123.jsonl');
    // Should not need to fall through to readdir
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('(b) falls back to nested worker dir when resolveTaskLog returns null and a matching file exists', async () => {
    mockResolveTaskLog.mockReturnValue(null);
    // readdir returns one worker directory
    mockReaddir.mockResolvedValue([
      makeDirent('worker-uuid-1', true),
      makeDirent('some-file.jsonl', false), // not a directory — should be skipped
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    // The candidate path inside that worker dir exists
    mockExistsSync.mockImplementation((p: unknown) =>
      (p as string).includes('worker-uuid-1'),
    );

    const result = await resolveLogPath('tq-abc123');

    expect(result).toBe('/data/work-logs/worker-uuid-1/tq-abc123.jsonl');
    expect(mockReaddir).toHaveBeenCalledWith('/data/work-logs', { withFileTypes: true });
  });

  it('(c) returns taskLogPath(id) fallback when no file is found anywhere', async () => {
    mockResolveTaskLog.mockReturnValue(null);
    mockReaddir.mockResolvedValue([
      makeDirent('worker-uuid-1', true),
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    // No candidate exists
    mockExistsSync.mockReturnValue(false);

    const result = await resolveLogPath('tq-abc123');

    expect(result).toBe('/data/work-logs/tq-abc123.jsonl');
    expect(mockTaskLogPath).toHaveBeenCalledWith('tq-abc123');
  });

  it('(c) returns taskLogPath(id) fallback when the logs directory does not exist (readdir throws)', async () => {
    mockResolveTaskLog.mockReturnValue(null);
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await resolveLogPath('tq-abc123');

    expect(result).toBe('/data/work-logs/tq-abc123.jsonl');
    expect(mockTaskLogPath).toHaveBeenCalledWith('tq-abc123');
  });
});

describe('resolveLogPath — worker UUID', () => {
  it('(d) returns the first file when workerLogFiles returns a non-empty list', async () => {
    mockWorkerLogFiles.mockResolvedValue([
      '/data/work-logs/worker-uuid-1/tq-task001.jsonl',
      '/data/work-logs/worker-uuid-1/tq-task000.jsonl',
    ]);

    const result = await resolveLogPath('worker-uuid-1');

    expect(result).toBe('/data/work-logs/worker-uuid-1/tq-task001.jsonl');
    expect(mockWorkerLogFiles).toHaveBeenCalledWith('worker-uuid-1');
    // resolveTaskLog / readdir should not be called for worker IDs
    expect(mockResolveTaskLog).not.toHaveBeenCalled();
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('(e) returns null when workerLogFiles returns an empty array', async () => {
    mockWorkerLogFiles.mockResolvedValue([]);

    const result = await resolveLogPath('worker-uuid-1');

    expect(result).toBeNull();
    expect(mockWorkerLogFiles).toHaveBeenCalledWith('worker-uuid-1');
  });
});
