/**
 * Unit tests for worker/src/claim.ts
 *
 * We mock exec from ../src/utils.js and test the three exported functions:
 *   - claimTask
 *   - claimTaskById
 *   - releaseTask
 *
 * hasDraftChildren is private but exercised indirectly via claimTask /
 * claimTaskById by controlling what the mocked exec returns for the
 * `tq list --parent <id> --status draft` call that follows a successful claim.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the entire utils module so no real child processes are spawned.
vi.mock('../src/utils.js');

import { exec } from '../src/utils.js';
import { claimTask, claimTaskById, releaseTask } from '../src/claim.js';

const mockExec = vi.mocked(exec);

// Convenience helpers to build ExecResult objects.
const ok = (stdout: string, stderr = '') => ({ stdout, stderr, exitCode: 0 });
const fail = (stderr: string, stdout = '', exitCode = 1) => ({ stdout, stderr, exitCode });

const AGENT = 'agent-abc';
const WORK_DIR = '/work';
const TASK_ID = 'tq-1234';

beforeEach(() => {
  vi.clearAllMocks();
  // Suppress process.stderr.write noise in tests
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// releaseTask
// ---------------------------------------------------------------------------

describe('releaseTask', () => {
  it('resolves without error on exitCode 0', async () => {
    mockExec.mockResolvedValue(ok(''));
    await expect(releaseTask(AGENT, WORK_DIR, TASK_ID)).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith('tq', ['release', TASK_ID, '--agent', AGENT], WORK_DIR);
  });

  it('throws Error when tq release exits non-zero', async () => {
    mockExec.mockResolvedValue(fail('release error'));
    await expect(releaseTask(AGENT, WORK_DIR, TASK_ID)).rejects.toThrow('tq release failed: release error');
  });
});

// ---------------------------------------------------------------------------
// claimTask
// ---------------------------------------------------------------------------

describe('claimTask', () => {
  it('returns null when tq claim outputs {task: null} (exitCode 0)', async () => {
    mockExec.mockResolvedValue(ok(JSON.stringify({ task: null })));
    const result = await claimTask(AGENT, WORK_DIR);
    expect(result).toBeNull();
    // Should only call exec once (no hasDraftChildren check needed)
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('throws Error when tq claim exits non-zero', async () => {
    mockExec.mockResolvedValue(fail('claim failed hard'));
    await expect(claimTask(AGENT, WORK_DIR)).rejects.toThrow('tq claim failed: claim failed hard');
  });

  it('returns the taskId on a normal successful claim with no draft children', async () => {
    mockExec
      // tq claim → success
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })))
      // tq list --parent ... --status draft → empty array
      .mockResolvedValueOnce(ok(JSON.stringify([])));

    const result = await claimTask(AGENT, WORK_DIR);
    expect(result).toBe(TASK_ID);
  });

  it('returns null and calls releaseTask when the claimed task is a parent with draft children (claimDraft=false)', async () => {
    mockExec
      // tq claim → returns a task
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })))
      // tq list → non-empty draft children
      .mockResolvedValueOnce(ok(JSON.stringify([{ id: 'tq-child-1' }])))
      // tq release → success
      .mockResolvedValueOnce(ok(''));

    const result = await claimTask(AGENT, WORK_DIR, false);
    expect(result).toBeNull();

    // Verify the release call happened with the right args
    const releaseCall = mockExec.mock.calls.find(
      (call) => call[1][0] === 'release',
    );
    expect(releaseCall).toBeDefined();
    expect(releaseCall![1]).toEqual(['release', TASK_ID, '--agent', AGENT]);
  });

  it('does NOT release when claimDraft=true even if draft children exist', async () => {
    mockExec
      // tq claim --draft → returns a task
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })))
      // tq list → non-empty draft children (should be checked but not trigger release)
      .mockResolvedValueOnce(ok(JSON.stringify([{ id: 'tq-child-1' }])));

    const result = await claimTask(AGENT, WORK_DIR, true);
    // hasDraftChildren check is skipped when claimDraft=true
    expect(result).toBe(TASK_ID);
    // release should never be called
    const releaseCall = mockExec.mock.calls.find(
      (call) => call[1][0] === 'release',
    );
    expect(releaseCall).toBeUndefined();
  });

  it('passes --draft flag to tq claim when claimDraft=true', async () => {
    mockExec.mockResolvedValue(ok(JSON.stringify({ task: null })));
    await claimTask(AGENT, WORK_DIR, true);
    expect(mockExec).toHaveBeenCalledWith(
      'tq',
      expect.arrayContaining(['--draft']),
      WORK_DIR,
    );
  });

  it('passes --role flag when role argument is provided', async () => {
    mockExec.mockResolvedValue(ok(JSON.stringify({ task: null })));
    await claimTask(AGENT, WORK_DIR, false, 'planner');
    expect(mockExec).toHaveBeenCalledWith(
      'tq',
      expect.arrayContaining(['--role', 'planner']),
      WORK_DIR,
    );
  });

  it('passes --capability flags for each entry in capabilities array', async () => {
    mockExec.mockResolvedValue(ok(JSON.stringify({ task: null })));
    await claimTask(AGENT, WORK_DIR, false, undefined, ['rust', 'gpu']);
    const args: string[] = mockExec.mock.calls[0][1];
    // Should contain two --capability flags
    const capIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === '--capability') acc.push(i);
      return acc;
    }, []);
    expect(capIndices).toHaveLength(2);
    expect(args[capIndices[0] + 1]).toBe('rust');
    expect(args[capIndices[1] + 1]).toBe('gpu');
  });
});

// ---------------------------------------------------------------------------
// claimTask — hasDraftChildren edge cases (tested indirectly)
// ---------------------------------------------------------------------------

describe('claimTask — hasDraftChildren edge cases', () => {
  it('returns false when tq list exits non-zero (no release triggered)', async () => {
    mockExec
      // tq claim
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })))
      // tq list fails → hasDraftChildren returns false
      .mockResolvedValueOnce(fail('permission denied'));

    const result = await claimTask(AGENT, WORK_DIR, false);
    expect(result).toBe(TASK_ID);
    const releaseCall = mockExec.mock.calls.find((c) => c[1][0] === 'release');
    expect(releaseCall).toBeUndefined();
  });

  it('returns false when tq list stdout is not valid JSON (no release triggered)', async () => {
    mockExec
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })))
      // invalid JSON
      .mockResolvedValueOnce(ok('not-json'));

    const result = await claimTask(AGENT, WORK_DIR, false);
    expect(result).toBe(TASK_ID);
    const releaseCall = mockExec.mock.calls.find((c) => c[1][0] === 'release');
    expect(releaseCall).toBeUndefined();
  });

  it('returns false when tq list returns empty array (no release triggered)', async () => {
    mockExec
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })))
      .mockResolvedValueOnce(ok(JSON.stringify([])));

    const result = await claimTask(AGENT, WORK_DIR, false);
    expect(result).toBe(TASK_ID);
    const releaseCall = mockExec.mock.calls.find((c) => c[1][0] === 'release');
    expect(releaseCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// claimTaskById
// ---------------------------------------------------------------------------

describe('claimTaskById', () => {
  it('returns the claimed task ID on success', async () => {
    mockExec
      // tq claim-id
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })))
      // tq list → no draft children
      .mockResolvedValueOnce(ok(JSON.stringify([])));

    const result = await claimTaskById(AGENT, WORK_DIR, TASK_ID);
    expect(result).toBe(TASK_ID);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      'tq',
      ['claim-id', TASK_ID, '--agent', AGENT],
      WORK_DIR,
    );
  });

  it('throws when tq claim-id exits non-zero', async () => {
    mockExec.mockResolvedValue(fail('not found', '', 1));
    await expect(claimTaskById(AGENT, WORK_DIR, TASK_ID)).rejects.toThrow(
      'tq claim-id failed: not found',
    );
  });

  it('throws and releases task when claimed task has draft children (claimDraft=false)', async () => {
    mockExec
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })))
      // draft children exist
      .mockResolvedValueOnce(ok(JSON.stringify([{ id: 'tq-child-1' }])))
      // release succeeds
      .mockResolvedValueOnce(ok(''));

    await expect(claimTaskById(AGENT, WORK_DIR, TASK_ID, false)).rejects.toThrow(
      `Task ${TASK_ID} is a parent with unrefined draft children`,
    );

    const releaseCall = mockExec.mock.calls.find((c) => c[1][0] === 'release');
    expect(releaseCall).toBeDefined();
    expect(releaseCall![1]).toEqual(['release', TASK_ID, '--agent', AGENT]);
  });

  it('does NOT throw for draft children when claimDraft=true', async () => {
    mockExec
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })));
    // hasDraftChildren is skipped entirely when claimDraft=true

    const result = await claimTaskById(AGENT, WORK_DIR, TASK_ID, true);
    expect(result).toBe(TASK_ID);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('passes --draft flag when claimDraft=true', async () => {
    mockExec.mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })));

    await claimTaskById(AGENT, WORK_DIR, TASK_ID, true);
    expect(mockExec).toHaveBeenCalledWith(
      'tq',
      expect.arrayContaining(['--draft']),
      WORK_DIR,
    );
  });

  it('passes --capability flags', async () => {
    mockExec
      .mockResolvedValueOnce(ok(JSON.stringify({ task: { id: TASK_ID } })))
      .mockResolvedValueOnce(ok(JSON.stringify([])));

    await claimTaskById(AGENT, WORK_DIR, TASK_ID, false, ['rust', 'arm64']);
    const args: string[] = mockExec.mock.calls[0][1];
    const capIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === '--capability') acc.push(i);
      return acc;
    }, []);
    expect(capIndices).toHaveLength(2);
    expect(args[capIndices[0] + 1]).toBe('rust');
    expect(args[capIndices[1] + 1]).toBe('arm64');
  });
});
