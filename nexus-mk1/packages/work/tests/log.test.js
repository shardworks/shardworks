/**
 * Unit tests for work/src/log.ts
 * Tests log path resolution, directory helpers, and event formatting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workLogsDir, taskLogPath, logFilePath, resolveTaskLog, listWorkerIds, workerLogFiles, } from '../src/log.js';
// ---------------------------------------------------------------------------
// Temp directory fixture for tests that touch the filesystem
// ---------------------------------------------------------------------------
const TEST_DIR = join(tmpdir(), `work-log-test-${process.pid}`);
let savedEnv;
beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env['WORK_LOGS_DIR'];
    mkdirSync(TEST_DIR, { recursive: true });
});
afterEach(() => {
    process.env = savedEnv;
    // Clean up test dir (best-effort)
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    }
    catch { }
});
// ---------------------------------------------------------------------------
// workLogsDir
// ---------------------------------------------------------------------------
describe('workLogsDir', () => {
    it('returns WORK_LOGS_DIR env var when set', () => {
        process.env['WORK_LOGS_DIR'] = '/custom/logs';
        expect(workLogsDir()).toBe('/custom/logs');
    });
    it('defaults to <cwd>/data/work-logs when env var is not set', () => {
        const result = workLogsDir();
        expect(result).toBe(join(process.cwd(), 'data', 'work-logs'));
    });
});
// ---------------------------------------------------------------------------
// taskLogPath
// ---------------------------------------------------------------------------
describe('taskLogPath', () => {
    it('returns path like <logsDir>/<taskId>.jsonl', () => {
        process.env['WORK_LOGS_DIR'] = '/logs';
        const p = taskLogPath('tq-abc12345');
        expect(p).toBe('/logs/tq-abc12345.jsonl');
    });
    it('uses the WORK_LOGS_DIR env var in the path', () => {
        process.env['WORK_LOGS_DIR'] = '/my/log/dir';
        expect(taskLogPath('tq-test0001')).toBe('/my/log/dir/tq-test0001.jsonl');
    });
});
// ---------------------------------------------------------------------------
// logFilePath (deprecated)
// ---------------------------------------------------------------------------
describe('logFilePath', () => {
    it('returns nested path <logsDir>/<workerId>/<taskId>.jsonl', () => {
        process.env['WORK_LOGS_DIR'] = '/logs';
        const p = logFilePath('worker-uuid-1', 'tq-abc12345');
        expect(p).toBe('/logs/worker-uuid-1/tq-abc12345.jsonl');
    });
});
// ---------------------------------------------------------------------------
// resolveTaskLog
// ---------------------------------------------------------------------------
describe('resolveTaskLog', () => {
    it('returns null when no log file exists for the task', () => {
        process.env['WORK_LOGS_DIR'] = TEST_DIR;
        const result = resolveTaskLog('tq-nosuchfile');
        expect(result).toBeNull();
    });
    it('returns the flat log path when the file exists in new layout', () => {
        process.env['WORK_LOGS_DIR'] = TEST_DIR;
        const taskId = 'tq-flatlog01';
        const logFile = join(TEST_DIR, `${taskId}.jsonl`);
        writeFileSync(logFile, '{"type":"init"}\n');
        const result = resolveTaskLog(taskId);
        expect(result).toBe(logFile);
    });
});
// ---------------------------------------------------------------------------
// listWorkerIds
// ---------------------------------------------------------------------------
describe('listWorkerIds', () => {
    it('returns empty array when the logs directory does not exist', async () => {
        process.env['WORK_LOGS_DIR'] = '/path/does/not/exist/xyz123';
        const ids = await listWorkerIds();
        expect(ids).toEqual([]);
    });
    it('returns subdirectory names (worker IDs) from the logs base dir', async () => {
        process.env['WORK_LOGS_DIR'] = TEST_DIR;
        // Create worker subdirectories
        mkdirSync(join(TEST_DIR, 'worker-aaa'), { recursive: true });
        mkdirSync(join(TEST_DIR, 'worker-bbb'), { recursive: true });
        // Also create a file (should be ignored)
        writeFileSync(join(TEST_DIR, 'tq-sometask.jsonl'), '');
        const ids = await listWorkerIds();
        expect(ids.sort()).toEqual(['worker-aaa', 'worker-bbb']);
    });
});
// ---------------------------------------------------------------------------
// workerLogFiles
// ---------------------------------------------------------------------------
describe('workerLogFiles', () => {
    it('returns empty array when worker directory does not exist', async () => {
        process.env['WORK_LOGS_DIR'] = TEST_DIR;
        const files = await workerLogFiles('no-such-worker');
        expect(files).toEqual([]);
    });
    it('returns .jsonl files sorted by modification time (newest first)', async () => {
        process.env['WORK_LOGS_DIR'] = TEST_DIR;
        const workerDir = join(TEST_DIR, 'worker-test');
        mkdirSync(workerDir, { recursive: true });
        // Create files with a small delay to ensure different mtimes
        const file1 = join(workerDir, 'tq-task0001.jsonl');
        const file2 = join(workerDir, 'tq-task0002.jsonl');
        writeFileSync(file1, '');
        // Touch file2 a moment later
        await new Promise(r => setTimeout(r, 10));
        writeFileSync(file2, '');
        const files = await workerLogFiles('worker-test');
        expect(files).toHaveLength(2);
        // file2 (newer) should come first
        expect(files[0]).toBe(file2);
        expect(files[1]).toBe(file1);
    });
    it('ignores non-.jsonl files in worker directory', async () => {
        process.env['WORK_LOGS_DIR'] = TEST_DIR;
        const workerDir = join(TEST_DIR, 'worker-filter');
        mkdirSync(workerDir, { recursive: true });
        writeFileSync(join(workerDir, 'tq-task0001.jsonl'), '');
        writeFileSync(join(workerDir, 'README.txt'), '');
        writeFileSync(join(workerDir, 'notes.json'), '');
        const files = await workerLogFiles('worker-filter');
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('tq-task0001.jsonl');
    });
});
//# sourceMappingURL=log.test.js.map