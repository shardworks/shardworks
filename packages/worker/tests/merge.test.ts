/**
 * Unit tests for worker/src/merge.ts
 *
 * mergeWorktreeToMain orchestrates a sequence of git/tq exec() calls.
 * We mock utils.ts (exec) and node:fs (existsSync, rmSync) so no real git
 * operations occur.
 *
 * parseUntrackedOverwriteFiles is a pure string-parsing helper exported for
 * direct testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils.js');

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    rmSync: vi.fn(),
  };
});

import { exec } from '../src/utils.js';
import { existsSync, rmSync } from 'node:fs';
import { mergeWorktreeToMain, parseUntrackedOverwriteFiles } from '../src/merge.js';

const mockExec      = vi.mocked(exec);
const mockExistsSync = vi.mocked(existsSync);
const mockRmSync     = vi.mocked(rmSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok  = (stdout = '', stderr = '') => ({ stdout, stderr, exitCode: 0 });
const err = (stderr = 'error', stdout = '') => ({ stdout, stderr, exitCode: 1 });

const TASK_ID  = 'tq-abc12345';
const WORK_DIR = '/workspace';
const AGENT    = 'agent-xyz';
const BRANCH   = `worktree-${TASK_ID}`;

/**
 * Set up exec mocks for a complete successful merge flow (no stale worktree dir).
 */
function setupSuccessFlow({
  aheadCount = 2,
  meta       = {
    description:  'Fix a bug',
    claimed_at:   '2026-01-01T10:00:00Z',
    completed_at: '2026-01-01T11:00:00Z',
  },
  commitSha = 'deadbeef123',
} = {}) {
  mockExec
    // 1. git rev-parse --verify <branch>
    .mockResolvedValueOnce(ok())
    // 2. git fetch origin main
    .mockResolvedValueOnce(ok())
    // 3. git rev-list --count main..<branch>
    .mockResolvedValueOnce(ok(String(aheadCount)))
    // 4. tq show <taskId>  (fetchTaskMeta)
    .mockResolvedValueOnce(ok(JSON.stringify(meta)))
    // 5. git merge --no-ff
    .mockResolvedValueOnce(ok())
    // 6. git push origin main  (pushWithRetry first attempt)
    .mockResolvedValueOnce(ok())
    // 7. git rev-parse HEAD
    .mockResolvedValueOnce(ok(commitSha))
    // 8. git branch -d <branch>  (cleanupWorktree — existsSync=false → no worktree remove)
    .mockResolvedValueOnce(ok());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// parseUntrackedOverwriteFiles — pure string parser, tested directly
// ===========================================================================

describe('parseUntrackedOverwriteFiles', () => {
  it('returns an empty array when the header line is absent', () => {
    expect(parseUntrackedOverwriteFiles('error: some other message\n')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseUntrackedOverwriteFiles('')).toEqual([]);
  });

  it('extracts file paths following the header line', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '        src/foo.ts',
      '        src/bar.ts',
      'Please move or remove them before you merge.',
      'Aborting',
    ].join('\n');

    expect(parseUntrackedOverwriteFiles(stderr)).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('stops capturing at a "Please" line', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '        file1.txt',
      'Please move or remove them.',
    ].join('\n');

    expect(parseUntrackedOverwriteFiles(stderr)).toEqual(['file1.txt']);
  });

  it('stops capturing at an "Aborting" line', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '        dist/index.js',
      'Aborting',
    ].join('\n');

    expect(parseUntrackedOverwriteFiles(stderr)).toEqual(['dist/index.js']);
  });

  it('stops capturing at a "Merge" line', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '        out.js',
      'Merge with strategy ours.',
    ].join('\n');

    expect(parseUntrackedOverwriteFiles(stderr)).toEqual(['out.js']);
  });

  it('stops capturing at a blank line', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '        a.ts',
      '',
      '        b.ts',
    ].join('\n');

    // blank line terminates capturing; b.ts should NOT be included
    expect(parseUntrackedOverwriteFiles(stderr)).toEqual(['a.ts']);
  });

  it('trims leading/trailing whitespace from each file path', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '   \t  some/path/file.ts  \t',
      'Aborting',
    ].join('\n');

    expect(parseUntrackedOverwriteFiles(stderr)).toEqual(['some/path/file.ts']);
  });

  it('handles a single file path with no trailing stop line', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '        package-lock.json',
    ].join('\n');

    expect(parseUntrackedOverwriteFiles(stderr)).toEqual(['package-lock.json']);
  });
});

// ===========================================================================
// mergeWorktreeToMain — no-branch
// ===========================================================================

describe('mergeWorktreeToMain — no-branch', () => {
  it('returns ok=true, reason="no-branch" when the branch does not exist', async () => {
    // git rev-parse --verify fails → branch absent
    mockExec.mockResolvedValueOnce(err('unknown revision'));

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-branch');
    expect(result.msg).toContain(BRANCH);
  });
});

// ===========================================================================
// mergeWorktreeToMain — no-commits
// ===========================================================================

describe('mergeWorktreeToMain — no-commits', () => {
  it('returns ok=true, reason="no-commits" when branch is 0 commits ahead of main', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse → exists
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('0')) // rev-list → 0
      .mockResolvedValueOnce(ok());   // branch -d (cleanup)

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-commits');
    expect(result.msg).toContain(BRANCH);
  });

  it('returns no-commits when rev-list output is empty (NaN)', async () => {
    mockExec
      .mockResolvedValueOnce(ok())   // rev-parse
      .mockResolvedValueOnce(ok())   // fetch
      .mockResolvedValueOnce(ok('')) // rev-list → NaN
      .mockResolvedValueOnce(ok());  // branch -d

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-commits');
  });
});

// ===========================================================================
// mergeWorktreeToMain — successful merge
// ===========================================================================

describe('mergeWorktreeToMain — successful merge', () => {
  it('returns ok=true, reason="merged", and the commit SHA on success', async () => {
    setupSuccessFlow({ commitSha: 'abc1234', aheadCount: 3 });

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('merged');
    expect(result.commitSha).toBe('abc1234');
    expect(result.msg).toContain('3 commit');
  });

  it('truncates long descriptions to 72 chars in the merge commit title', async () => {
    const longDesc = 'A'.repeat(100);
    setupSuccessFlow({
      meta: {
        description:  longDesc,
        claimed_at:   '2026-01-01T10:00:00Z',
        completed_at: '2026-01-01T11:00:00Z',
      },
    });

    await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);

    const mergeCall = mockExec.mock.calls.find((c) => c[0] === 'git' && c[1][0] === 'merge');
    expect(mergeCall).toBeDefined();
    const mIdx = mergeCall![1].indexOf('-m');
    const title = mergeCall![1][mIdx + 1] as string;
    // Title = truncated description (≤72 chars) + " [taskId]"
    const descPart = title.replace(` [${TASK_ID}]`, '');
    expect(descPart.length).toBeLessThanOrEqual(72);
  });

  it('falls back to taskId as description when tq show fails', async () => {
    mockExec
      .mockResolvedValueOnce(ok())            // rev-parse
      .mockResolvedValueOnce(ok())            // fetch
      .mockResolvedValueOnce(ok('1'))         // rev-list
      .mockResolvedValueOnce(err('not found')) // tq show fails → fallback
      .mockResolvedValueOnce(ok())            // merge
      .mockResolvedValueOnce(ok())            // push
      .mockResolvedValueOnce(ok('sha999'))    // rev-parse HEAD
      .mockResolvedValueOnce(ok());           // branch -d

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('merged');

    const mergeCall = mockExec.mock.calls.find((c) => c[0] === 'git' && c[1][0] === 'merge');
    const mIdx = mergeCall![1].indexOf('-m');
    const title = mergeCall![1][mIdx + 1] as string;
    expect(title).toContain(TASK_ID);
  });

  it('calls git worktree remove when the worktree directory exists', async () => {
    mockExistsSync.mockReturnValue(true); // worktree path exists

    mockExec
      .mockResolvedValueOnce(ok())     // rev-parse
      .mockResolvedValueOnce(ok())     // fetch
      .mockResolvedValueOnce(ok('1'))  // rev-list
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'fix', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(ok())     // merge
      .mockResolvedValueOnce(ok())     // push
      .mockResolvedValueOnce(ok('sha123')) // rev-parse HEAD
      .mockResolvedValueOnce(ok())     // git worktree remove
      .mockResolvedValueOnce(ok());    // git branch -d

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(true);

    const wtRemoveCall = mockExec.mock.calls.find(
      (c) => c[0] === 'git' && c[1][0] === 'worktree' && c[1][1] === 'remove',
    );
    expect(wtRemoveCall).toBeDefined();
  });

  it('does not call git worktree remove when the worktree directory is absent', async () => {
    mockExistsSync.mockReturnValue(false);
    setupSuccessFlow();

    await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);

    const wtRemoveCall = mockExec.mock.calls.find(
      (c) => c[0] === 'git' && c[1][0] === 'worktree' && c[1][1] === 'remove',
    );
    expect(wtRemoveCall).toBeUndefined();
  });
});

// ===========================================================================
// mergeWorktreeToMain — merge conflict
// ===========================================================================

describe('mergeWorktreeToMain — merge conflict', () => {
  it('returns ok=false, reason="conflict" when git merge fails without untracked file error', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('1')) // rev-list
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'task', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(err('CONFLICT (content): Merge conflict in src/foo.ts')) // merge
      // tryAutoResolveLockfileConflicts: diff returns non-lock file → returns false
      .mockResolvedValueOnce(ok('src/foo.ts'))  // git diff --name-only --diff-filter=U
      .mockResolvedValueOnce(ok());   // git merge --abort

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('conflict');
    expect(result.msg).toContain(BRANCH);

    const abortCall = mockExec.mock.calls.find(
      (c) => c[0] === 'git' && c[1].includes('--abort'),
    );
    expect(abortCall).toBeDefined();
  });

  it('auto-resolves when the only conflict is package-lock.json', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('1')) // rev-list
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'task', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(err('CONFLICT (content): Merge conflict in package-lock.json')) // merge
      // tryAutoResolveLockfileConflicts: only package-lock.json
      .mockResolvedValueOnce(ok('package-lock.json'))  // git diff --name-only --diff-filter=U
      .mockResolvedValueOnce(ok())    // git checkout --theirs package-lock.json
      .mockResolvedValueOnce(ok())    // npm install --package-lock-only
      .mockResolvedValueOnce(ok())    // git add package-lock.json
      .mockResolvedValueOnce(ok())    // git commit --no-edit
      // push flow
      .mockResolvedValueOnce(ok())    // git push origin main
      .mockResolvedValueOnce(ok('auto-sha')) // git rev-parse HEAD
      .mockResolvedValueOnce(ok());   // git branch -d

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('merged');
    expect(result.commitSha).toBe('auto-sha');

    // Confirm git merge --abort was NOT called
    const abortCall = mockExec.mock.calls.find(
      (c) => c[0] === 'git' && c[1].includes('--abort'),
    );
    expect(abortCall).toBeUndefined();

    // Confirm npm install --package-lock-only was called
    const npmCall = mockExec.mock.calls.find(
      (c) => c[0] === 'npm' && c[1].includes('--package-lock-only'),
    );
    expect(npmCall).toBeDefined();
  });

  it('falls back to conflict when npm install fails during lock-file auto-resolution', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('1')) // rev-list
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'task', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(err('CONFLICT (content): Merge conflict in package-lock.json')) // merge
      // tryAutoResolveLockfileConflicts: npm install fails
      .mockResolvedValueOnce(ok('package-lock.json'))  // git diff --name-only --diff-filter=U
      .mockResolvedValueOnce(ok())    // git checkout --theirs package-lock.json
      .mockResolvedValueOnce(err('npm ERR! missing package.json')) // npm install fails
      .mockResolvedValueOnce(ok());   // git merge --abort

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('conflict');
  });

  it('falls back to conflict when package-lock.json conflicts alongside other files', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('1')) // rev-list
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'task', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(err('CONFLICT in src/index.ts\nCONFLICT in package-lock.json')) // merge
      // tryAutoResolveLockfileConflicts: mixed files — bail out
      .mockResolvedValueOnce(ok('src/index.ts\npackage-lock.json'))  // git diff --name-only --diff-filter=U
      .mockResolvedValueOnce(ok());   // git merge --abort

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('conflict');
  });
});

// ===========================================================================
// mergeWorktreeToMain — untracked file conflict retry
// ===========================================================================

describe('mergeWorktreeToMain — untracked file retry', () => {
  const untrackedStderr = [
    'error: The following untracked working tree files would be overwritten by merge:',
    '        stale/file.ts',
    'Please move or remove them before you merge.',
    'Aborting',
  ].join('\n');

  it('removes stale files and retries the merge on untracked-file conflict', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('1')) // rev-list
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'task', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(err(untrackedStderr)) // first merge → untracked
      .mockResolvedValueOnce(ok())    // second merge (after file removal) → success
      .mockResolvedValueOnce(ok())    // push
      .mockResolvedValueOnce(ok('sha456')) // rev-parse HEAD
      .mockResolvedValueOnce(ok());   // branch -d

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('merged');

    // rmSync should have been called for the stale file
    expect(mockRmSync).toHaveBeenCalled();
    const rmCallArg = String(mockRmSync.mock.calls[0]![0]);
    expect(rmCallArg).toContain('stale/file.ts');
  });

  it('returns conflict when the retry merge also fails', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('1')) // rev-list
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'task', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(err(untrackedStderr))       // first merge → untracked
      .mockResolvedValueOnce(err('still conflicting'))  // second merge → still fails
      // tryAutoResolveLockfileConflicts: non-lock conflict → bail
      .mockResolvedValueOnce(ok('src/bar.ts'))  // git diff --name-only --diff-filter=U
      .mockResolvedValueOnce(ok());   // git merge --abort

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('conflict');
  });
});

// ===========================================================================
// mergeWorktreeToMain — push failed
// ===========================================================================

describe('mergeWorktreeToMain — push failed', () => {
  it('returns ok=false, reason="push-failed" when push fails after retry', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('1')) // rev-list
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'task', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(ok())    // merge succeeds
      // pushWithRetry: push1 fails → pull --rebase ok → push2 fails
      .mockResolvedValueOnce(err('rejected'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(err('still rejected'))
      // roll back
      .mockResolvedValueOnce(ok()); // git reset --hard ORIG_HEAD

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('push-failed');
    expect(result.msg).toContain('Failed to push');
  });

  it('returns ok=false when pull --rebase itself fails', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('1')) // rev-list
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'task', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(ok())    // merge
      .mockResolvedValueOnce(err('network error')) // push1 fails
      .mockResolvedValueOnce(err('rebase failed'))  // pull --rebase fails
      .mockResolvedValueOnce(ok());   // git reset --hard ORIG_HEAD

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('push-failed');
    expect(result.msg).toContain('pull --rebase failed');
  });

  it('succeeds when push1 fails but push2 succeeds after rebase', async () => {
    mockExec
      .mockResolvedValueOnce(ok())    // rev-parse
      .mockResolvedValueOnce(ok())    // fetch
      .mockResolvedValueOnce(ok('3')) // rev-list → 3 commits
      .mockResolvedValueOnce(ok(JSON.stringify({ description: 'task', claimed_at: null, completed_at: null })))
      .mockResolvedValueOnce(ok())    // merge
      .mockResolvedValueOnce(err('rejected')) // push1 fails
      .mockResolvedValueOnce(ok())    // pull --rebase ok
      .mockResolvedValueOnce(ok())    // push2 ok
      .mockResolvedValueOnce(ok('sha789')) // rev-parse HEAD
      .mockResolvedValueOnce(ok());   // branch -d

    const result = await mergeWorktreeToMain(TASK_ID, WORK_DIR, AGENT);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('merged');
    expect(result.msg).toContain('3 commit');
  });
});
