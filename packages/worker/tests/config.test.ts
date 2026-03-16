/**
 * Unit tests for worker/src/config.ts
 *
 * configFromParsedOpts() reads Commander's parsed options + env vars.
 * We spy on program.opts() to control what options it returns, and set
 * process.env variables before each test (restored via beforeEach cleanup).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { program, configFromParsedOpts } from '../src/config.js';

// ---------------------------------------------------------------------------
// Snapshot the env before each test and restore it after
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear worker-relevant env vars so tests start from a clean slate
  delete process.env['WORKER_ROLE'];
  delete process.env['AGENT_TAGS'];
  delete process.env['WORK_DIR'];
  delete process.env['CLAUDE_MODEL'];
  delete process.env['CLAUDE_MAX_BUDGET_USD'];
});

afterEach(() => {
  process.env = savedEnv;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spy on program.opts() to return controlled values. */
function mockOpts(opts: { taskId?: string; role?: string; interactive?: boolean }) {
  vi.spyOn(program, 'opts').mockReturnValue({
    role: 'implementer',
    interactive: false,
    ...opts,
  } as ReturnType<typeof program.opts>);
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

describe('configFromParsedOpts — mode detection', () => {
  it('returns one-shot mode when no --task-id is provided', () => {
    mockOpts({ role: 'implementer' });
    const config = configFromParsedOpts();
    expect(config.mode).toBe('one-shot');
  });

  it('returns conducted mode when --task-id is provided', () => {
    mockOpts({ taskId: 'tq-abc12345', role: 'implementer' });
    const config = configFromParsedOpts();
    expect(config.mode).toBe('conducted');
    if (config.mode === 'conducted') {
      expect(config.taskId).toBe('tq-abc12345');
    }
  });
});

// ---------------------------------------------------------------------------
// agentId
// ---------------------------------------------------------------------------

describe('configFromParsedOpts — agentId', () => {
  it('generates a fresh UUID on every call', () => {
    mockOpts({ role: 'implementer' });
    const config1 = configFromParsedOpts();
    const config2 = configFromParsedOpts();
    // UUIDs should differ between invocations (ephemeral)
    expect(config1.agentId).not.toBe(config2.agentId);
  });

  it('agentId is a valid UUID v4 format', () => {
    mockOpts({ role: 'implementer' });
    const { agentId } = configFromParsedOpts();
    expect(agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------------------------------------------------------------------------
// role
// ---------------------------------------------------------------------------

describe('configFromParsedOpts — role', () => {
  it('uses the role from parsed options', () => {
    mockOpts({ role: 'planner' });
    const { role } = configFromParsedOpts();
    expect(role).toBe('planner');
  });

  it('defaults to "implementer" when no role is specified', () => {
    mockOpts({ role: 'implementer' });
    const { role } = configFromParsedOpts();
    expect(role).toBe('implementer');
  });
});

// ---------------------------------------------------------------------------
// agentTags
// ---------------------------------------------------------------------------

describe('configFromParsedOpts — agentTags', () => {
  it('returns empty array when AGENT_TAGS is not set', () => {
    mockOpts({ role: 'implementer' });
    const { agentTags } = configFromParsedOpts();
    expect(agentTags).toEqual([]);
  });

  it('parses comma-separated AGENT_TAGS', () => {
    process.env['AGENT_TAGS'] = 'rust, gpu, arm64';
    mockOpts({ role: 'implementer' });
    const { agentTags } = configFromParsedOpts();
    expect(agentTags).toEqual(['rust', 'gpu', 'arm64']);
  });

  it('filters out empty tags from AGENT_TAGS', () => {
    process.env['AGENT_TAGS'] = 'a,,b,';
    mockOpts({ role: 'implementer' });
    const { agentTags } = configFromParsedOpts();
    expect(agentTags).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// workDir
// ---------------------------------------------------------------------------

describe('configFromParsedOpts — workDir', () => {
  it('defaults to process.cwd() when WORK_DIR is not set', () => {
    mockOpts({ role: 'implementer' });
    const { workDir } = configFromParsedOpts();
    expect(workDir).toBe(process.cwd());
  });

  it('uses WORK_DIR env var when set', () => {
    process.env['WORK_DIR'] = '/custom/work/dir';
    mockOpts({ role: 'implementer' });
    const { workDir } = configFromParsedOpts();
    expect(workDir).toBe('/custom/work/dir');
  });
});

// ---------------------------------------------------------------------------
// claudeModel
// ---------------------------------------------------------------------------

describe('configFromParsedOpts — claudeModel', () => {
  it('defaults to "sonnet" when CLAUDE_MODEL is not set', () => {
    mockOpts({ role: 'implementer' });
    const { claudeModel } = configFromParsedOpts();
    expect(claudeModel).toBe('sonnet');
  });

  it('uses CLAUDE_MODEL env var when set', () => {
    process.env['CLAUDE_MODEL'] = 'claude-opus-4-5';
    mockOpts({ role: 'implementer' });
    const { claudeModel } = configFromParsedOpts();
    expect(claudeModel).toBe('claude-opus-4-5');
  });
});

// ---------------------------------------------------------------------------
// claudeMaxBudgetUsd
// ---------------------------------------------------------------------------

describe('configFromParsedOpts — claudeMaxBudgetUsd', () => {
  it('is undefined when CLAUDE_MAX_BUDGET_USD is not set', () => {
    mockOpts({ role: 'implementer' });
    const { claudeMaxBudgetUsd } = configFromParsedOpts();
    expect(claudeMaxBudgetUsd).toBeUndefined();
  });

  it('parses CLAUDE_MAX_BUDGET_USD as a float', () => {
    process.env['CLAUDE_MAX_BUDGET_USD'] = '2.50';
    mockOpts({ role: 'implementer' });
    const { claudeMaxBudgetUsd } = configFromParsedOpts();
    expect(claudeMaxBudgetUsd).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// interactive
// ---------------------------------------------------------------------------

describe('configFromParsedOpts — interactive', () => {
  it('uses the interactive flag from options when explicitly set', () => {
    mockOpts({ role: 'implementer', interactive: true });
    const { interactive } = configFromParsedOpts();
    expect(interactive).toBe(true);
  });

  it('uses false from options when --no-interactive is set', () => {
    mockOpts({ role: 'implementer', interactive: false });
    const { interactive } = configFromParsedOpts();
    expect(interactive).toBe(false);
  });
});
