/**
 * Unit tests for worker/src/roles.ts (loadRole, renderSystemPrompt, renderWorkPrompt)
 * and worker/src/launcher.ts (detectRateLimit, parseRetryAfter, buildArgs, formatEvent).
 *
 * Roles are loaded from a temp JSON file written to the OS temp directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRole,
  renderSystemPrompt,
  renderWorkPrompt,
  type RoleDefinition,
  type PromptVars,
} from '../src/roles.js';
import {
  detectRateLimit,
  parseRetryAfter,
  buildArgs,
  formatEvent,
} from '../src/launcher.js';

// ---------------------------------------------------------------------------
// Temp roles.json fixture
// ---------------------------------------------------------------------------

const ROLES_FILE = join(tmpdir(), `worker-test-roles-${process.pid}.json`);

const SAMPLE_ROLE: RoleDefinition = {
  id: 'implementer',
  description: 'Default implementer role',
  claimDraft: false,
  systemPrompt: [
    'You are agent {{agentId}}.',
    'Tags:{{tagsLine}}',
    'Prior work:{{priorWorkNotice}}',
  ],
  workPrompt: [
    'Work on task {{taskId}} as {{agentId}}.',
    'Log: {{logPath}}',
  ],
};

const PLANNER_ROLE: RoleDefinition = {
  id: 'planner',
  description: 'Planning role',
  claimDraft: true,
  model: 'claude-haiku-4-5',
  allowedTools: ['Bash', 'Read'],
  systemPrompt: ['You are a planner.'],
  workPrompt: ['Plan task {{taskId}}.'],
};

function writeRolesFile(roles: RoleDefinition[] = [SAMPLE_ROLE, PLANNER_ROLE]) {
  writeFileSync(ROLES_FILE, JSON.stringify({ roles }), 'utf8');
  process.env['ROLES_CONFIG'] = ROLES_FILE;
}

beforeEach(() => {
  writeRolesFile();
});

afterEach(() => {
  delete process.env['ROLES_CONFIG'];
  delete process.env['WORK_LOGS_DIR'];
  if (existsSync(ROLES_FILE)) unlinkSync(ROLES_FILE);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// loadRole
// ---------------------------------------------------------------------------

describe('loadRole', () => {
  it('returns the matching RoleDefinition by ID', () => {
    const role = loadRole('implementer', '/tmp');
    expect(role.id).toBe('implementer');
    expect(role.claimDraft).toBe(false);
  });

  it('returns a role with allowedTools when defined', () => {
    const role = loadRole('planner', '/tmp');
    expect(role.allowedTools).toEqual(['Bash', 'Read']);
  });

  it('returns a role with model override when defined', () => {
    const role = loadRole('planner', '/tmp');
    expect(role.model).toBe('claude-haiku-4-5');
  });

  it('throws a descriptive error for an unknown role ID', () => {
    expect(() => loadRole('nonexistent', '/tmp')).toThrow(/Unknown role "nonexistent"/);
    expect(() => loadRole('nonexistent', '/tmp')).toThrow(/implementer.*planner/);
  });

  it('throws when roles.json cannot be read', () => {
    process.env['ROLES_CONFIG'] = '/path/that/does/not/exist.json';
    expect(() => loadRole('implementer', '/tmp')).toThrow(/Failed to load roles config/);
  });
});

// ---------------------------------------------------------------------------
// renderSystemPrompt
// ---------------------------------------------------------------------------

describe('renderSystemPrompt', () => {
  const baseVars: PromptVars = {
    agentId: 'agent-uuid-1234',
    taskId: 'tq-abc12345',
    agentTags: [],
    workDir: '/tmp',
  };

  it('substitutes {{agentId}} with the agent ID', () => {
    const role = loadRole('implementer', '/tmp');
    const prompt = renderSystemPrompt(role, baseVars);
    expect(prompt).toContain('agent-uuid-1234');
    expect(prompt).not.toContain('{{agentId}}');
  });

  it('produces empty tagsLine when no tags are set', () => {
    const role = loadRole('implementer', '/tmp');
    const prompt = renderSystemPrompt(role, { ...baseVars, agentTags: [] });
    expect(prompt).not.toContain('Capability tags');
    expect(prompt).not.toContain('{{tagsLine}}');
  });

  it('includes capability tags when tags are set', () => {
    const role = loadRole('implementer', '/tmp');
    const prompt = renderSystemPrompt(role, { ...baseVars, agentTags: ['rust', 'gpu'] });
    expect(prompt).toContain('Capability tags: rust, gpu');
  });

  it('includes prior-work notice when WORK_LOGS_DIR log file exists', () => {
    // Point WORK_LOGS_DIR to tmpdir and create a fake log file
    process.env['WORK_LOGS_DIR'] = tmpdir();
    const taskId = 'tq-abc12345';
    const logFile = join(tmpdir(), `${taskId}.jsonl`);
    writeFileSync(logFile, '{"type":"init"}\n');
    try {
      const role = loadRole('implementer', '/tmp');
      const prompt = renderSystemPrompt(role, { ...baseVars, taskId });
      expect(prompt).toContain('Previous work on this task was interrupted');
    } finally {
      unlinkSync(logFile);
    }
  });

  it('produces empty priorWorkNotice when no prior log exists', () => {
    process.env['WORK_LOGS_DIR'] = tmpdir();
    const role = loadRole('implementer', '/tmp');
    const prompt = renderSystemPrompt(role, { ...baseVars, taskId: 'tq-nosuchlog' });
    expect(prompt).not.toContain('Previous work');
    expect(prompt).not.toContain('{{priorWorkNotice}}');
  });
});

// ---------------------------------------------------------------------------
// renderWorkPrompt
// ---------------------------------------------------------------------------

describe('renderWorkPrompt', () => {
  const baseVars: PromptVars = {
    agentId: 'agent-abc',
    taskId: 'tq-work1234',
    agentTags: [],
    workDir: '/tmp',
  };

  it('substitutes {{taskId}} with the task ID', () => {
    const role = loadRole('implementer', '/tmp');
    const prompt = renderWorkPrompt(role, baseVars);
    expect(prompt).toContain('tq-work1234');
    expect(prompt).not.toContain('{{taskId}}');
  });

  it('substitutes {{agentId}} with the agent ID', () => {
    const role = loadRole('implementer', '/tmp');
    const prompt = renderWorkPrompt(role, baseVars);
    expect(prompt).toContain('agent-abc');
    expect(prompt).not.toContain('{{agentId}}');
  });

  it('substitutes {{logPath}} with the relative log path', () => {
    const role = loadRole('implementer', '/tmp');
    const prompt = renderWorkPrompt(role, baseVars);
    expect(prompt).toContain('data/work-logs/tq-work1234.jsonl');
    expect(prompt).not.toContain('{{logPath}}');
  });
});

// ---------------------------------------------------------------------------
// detectRateLimit (from launcher.ts)
// ---------------------------------------------------------------------------

describe('detectRateLimit', () => {
  it('returns false for non-error events', () => {
    expect(detectRateLimit({ type: 'result', is_error: false, result: 'done' })).toBe(false);
  });

  it('returns false for errors with a positive cost (not a rate limit)', () => {
    expect(detectRateLimit({
      type: 'result',
      is_error: true,
      total_cost_usd: 0.05,
      result: 'Too many requests',
    })).toBe(false);
  });

  it('returns true when error message matches "hit your limit"', () => {
    expect(detectRateLimit({
      type: 'result',
      is_error: true,
      total_cost_usd: 0,
      result: 'You hit your limit',
    })).toBe(true);
  });

  it('returns true when error message matches "rate limit"', () => {
    expect(detectRateLimit({
      type: 'result',
      is_error: true,
      result: 'Rate limit exceeded',
    })).toBe(true);
  });

  it('returns true when error message matches "too many requests"', () => {
    expect(detectRateLimit({
      type: 'result',
      is_error: true,
      result: 'Too many requests. Please try again.',
    })).toBe(true);
  });

  it('returns true when error message contains "resets <time>"', () => {
    expect(detectRateLimit({
      type: 'result',
      is_error: true,
      result: 'Limit resets 5pm (UTC)',
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfter (from launcher.ts)
// ---------------------------------------------------------------------------

describe('parseRetryAfter', () => {
  it('returns null when message has no "resets <time>" pattern', () => {
    expect(parseRetryAfter('Rate limit exceeded')).toBeNull();
  });

  it('returns null for non-UTC timezones', () => {
    expect(parseRetryAfter('resets 5pm (EST)')).toBeNull();
  });

  it('returns an ISO string for "resets 5pm (UTC)"', () => {
    const result = parseRetryAfter('You have hit your limit, resets 5pm (UTC)');
    expect(result).not.toBeNull();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // The parsed time should be 17:00 UTC
    const parsed = new Date(result!);
    expect(parsed.getUTCHours()).toBe(17);
    expect(parsed.getUTCMinutes()).toBe(0);
  });

  it('returns an ISO string for "resets 17:30 (UTC)"', () => {
    const result = parseRetryAfter('Limit resets 17:30 (UTC)');
    expect(result).not.toBeNull();
    const parsed = new Date(result!);
    expect(parsed.getUTCHours()).toBe(17);
    expect(parsed.getUTCMinutes()).toBe(30);
  });

  it('handles "resets 12am (UTC)" (midnight)', () => {
    const result = parseRetryAfter('resets 12am (UTC)');
    expect(result).not.toBeNull();
    const parsed = new Date(result!);
    expect(parsed.getUTCHours()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildArgs (from launcher.ts)
// ---------------------------------------------------------------------------

describe('buildArgs', () => {
  const baseConfig = {
    mode: 'conducted' as const,
    agentId: 'agent-test-uuid',
    taskId: 'tq-buildtest',
    role: 'implementer',
    agentTags: [],
    workDir: '/tmp',
    claudeModel: 'sonnet',
    interactive: false,
  };

  it('includes required claude CLI flags', () => {
    const { args } = buildArgs(baseConfig);
    expect(args).toContain('-p');
    expect(args).toContain('--verbose');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
  });

  it('includes --model from role (if set) or config', () => {
    // PLANNER_ROLE has model: 'claude-haiku-4-5'
    const { args } = buildArgs({ ...baseConfig, role: 'planner' });
    expect(args).toContain('--model');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('claude-haiku-4-5');
  });

  it('falls back to config.claudeModel when role has no model override', () => {
    // SAMPLE_ROLE (implementer) has no model override
    const { args } = buildArgs({ ...baseConfig, claudeModel: 'claude-opus-4-5' });
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('claude-opus-4-5');
  });

  it('includes --worktree with task ID for roles that need file editing', () => {
    // implementer has no allowedTools restriction → needs worktree
    const { args } = buildArgs(baseConfig);
    expect(args).toContain('--worktree');
    const wtIdx = args.indexOf('--worktree');
    expect(args[wtIdx + 1]).toBe('tq-buildtest');
  });

  it('omits --worktree for roles restricted to non-editing tools', () => {
    // planner role has allowedTools: ['Bash', 'Read'] — no Write/Edit
    const { args } = buildArgs({ ...baseConfig, role: 'planner' });
    expect(args).not.toContain('--worktree');
  });

  it('includes --tools when allowedTools is set in the role', () => {
    const { args } = buildArgs({ ...baseConfig, role: 'planner' });
    expect(args).toContain('--tools');
    const toolsIdx = args.indexOf('--tools');
    expect(args[toolsIdx + 1]).toBe('Bash,Read');
  });

  it('omits --tools when allowedTools is not set', () => {
    const { args } = buildArgs(baseConfig); // implementer has no allowedTools
    expect(args).not.toContain('--tools');
  });

  it('includes --max-budget-usd when claudeMaxBudgetUsd is set', () => {
    const { args } = buildArgs({ ...baseConfig, claudeMaxBudgetUsd: 2.5 });
    expect(args).toContain('--max-budget-usd');
    const budgetIdx = args.indexOf('--max-budget-usd');
    expect(args[budgetIdx + 1]).toBe('2.5');
  });

  it('omits --max-budget-usd when claudeMaxBudgetUsd is not set', () => {
    const { args } = buildArgs(baseConfig);
    expect(args).not.toContain('--max-budget-usd');
  });

  it('includes --system-prompt in args and returns a non-empty work prompt', () => {
    const { args, prompt } = buildArgs(baseConfig);
    expect(args).toContain('--system-prompt');
    // The work prompt is returned separately (piped to stdin) and must be non-empty
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('tq-buildtest'); // taskId substituted into work prompt
  });
});

// ---------------------------------------------------------------------------
// formatEvent (from launcher.ts)
// ---------------------------------------------------------------------------

describe('formatEvent (launcher)', () => {
  it('returns null for unknown event types', () => {
    expect(formatEvent({ type: 'system', subtype: 'init' })).toBeNull();
    expect(formatEvent({ type: 'unknown' })).toBeNull();
  });

  it('formats assistant text blocks', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello world' }],
      },
    };
    const result = formatEvent(event);
    expect(result).toContain('Hello world');
  });

  it('formats assistant thinking blocks', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'Let me think...' }],
      },
    };
    const result = formatEvent(event);
    expect(result).toContain('[thinking]');
    expect(result).toContain('Let me think...');
  });

  it('formats tool_use blocks with name', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }],
      },
    };
    const result = formatEvent(event);
    expect(result).toContain('[tool] Bash');
    expect(result).toContain('ls -la');
  });

  it('formats tool_result blocks', () => {
    const event = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: 'file1.txt\nfile2.txt' }],
      },
    };
    const result = formatEvent(event);
    expect(result).toContain('[result]');
  });

  it('formats result event with cost', () => {
    const event = {
      type: 'result',
      total_cost_usd: 0.0123,
    };
    const result = formatEvent(event);
    expect(result).toContain('[done]');
    expect(result).toContain('$0.0123');
  });

  it('returns null for assistant event with empty content', () => {
    const event = { type: 'assistant', message: { content: [] } };
    expect(formatEvent(event)).toBeNull();
  });

  it('truncates long tool input hints to 120 chars', () => {
    const longCmd = 'x'.repeat(200);
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: longCmd } }],
      },
    };
    const result = formatEvent(event)!;
    // The hint should be truncated (120 chars + ': ' prefix + '…' suffix)
    expect(result).toContain('…');
    // The tool_use portion should not contain all 200 chars
    expect(result.length).toBeLessThan(200);
  });
});
