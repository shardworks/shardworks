/**
 * Smoke tests for packages/work/src/cli.ts argument parsing.
 *
 * Commander calls program.parse() at module load time, so the CLI module must
 * be imported dynamically after:
 *   1. process.argv is set to the desired arguments, and
 *   2. vi.resetModules() has been called so a fresh Commander instance is
 *      created for each test.
 *
 * Actual implementations (watch, dashboard, pool.end) are mocked so they
 * never run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any import by Vitest
// ---------------------------------------------------------------------------

vi.mock('../src/watch.js', () => ({
  watch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/dashboard.js', () => ({
  dashboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/db.js', () => ({
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dynamically import a fresh copy of cli.ts with the given argv tail. */
async function runCli(...args: string[]): Promise<void> {
  // Commander reads process.argv; node + binary name are the first two entries.
  process.argv = ['node', 'work', ...args];
  vi.resetModules();
  await import('../src/cli.js');
}

/** Resolve the mock for watch after resetModules. */
async function getWatchMock() {
  const mod = await import('../src/watch.js');
  return mod.watch as ReturnType<typeof vi.fn>;
}

/** Resolve the mock for dashboard after resetModules. */
async function getDashboardMock() {
  const mod = await import('../src/dashboard.js');
  return mod.dashboard as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const originalArgv = process.argv;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    // Prevent Commander / the test runner from actually exiting.
  }) as (code?: number) => never);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('CLI argument routing', () => {
  it('routes "work watch tq-abc123" to watch(tq-abc123)', async () => {
    await runCli('watch', 'tq-abc123');
    const watchFn = await getWatchMock();
    // Allow the async action handler to flush.
    await vi.waitFor(() => expect(watchFn).toHaveBeenCalledWith('tq-abc123'));
  });

  it('routes "work watch some-uuid" to watch(some-uuid)', async () => {
    await runCli('watch', 'some-uuid');
    const watchFn = await getWatchMock();
    await vi.waitFor(() => expect(watchFn).toHaveBeenCalledWith('some-uuid'));
  });

  it('routes "work dashboard" to dashboard()', async () => {
    await runCli('dashboard');
    const dashFn = await getDashboardMock();
    await vi.waitFor(() => expect(dashFn).toHaveBeenCalled());
  });

  it('routes "work dash" (alias) to dashboard()', async () => {
    await runCli('dash');
    const dashFn = await getDashboardMock();
    await vi.waitFor(() => expect(dashFn).toHaveBeenCalled());
  });

  it('exits with non-zero when an unknown command is given', async () => {
    await runCli('unknown-cmd');
    expect(exitSpy).toHaveBeenCalledWith(expect.any(Number));
    const code = exitSpy.mock.calls[0]?.[0] as number | undefined;
    expect(typeof code === 'undefined' || code !== 0).toBe(true);
  });

  it('exits with non-zero when "watch" is called without a required <id> argument', async () => {
    await runCli('watch');
    expect(exitSpy).toHaveBeenCalledWith(expect.any(Number));
    const code = exitSpy.mock.calls[0]?.[0] as number | undefined;
    expect(typeof code === 'undefined' || code !== 0).toBe(true);
  });
});
