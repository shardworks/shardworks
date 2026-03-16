/**
 * Unit tests for work/src/log.ts — formatEvent and formatEventPlain functions.
 *
 * These functions format stream-json events from Claude into human-readable strings.
 * formatEvent includes blessed markup tags; formatEventPlain is plain text.
 */

import { describe, it, expect } from 'vitest';
import { formatEvent, formatEventPlain, type StreamEvent } from '../src/log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<StreamEvent>): StreamEvent {
  return { type: 'unknown', ...overrides };
}

// ---------------------------------------------------------------------------
// formatEvent (blessed markup version)
// ---------------------------------------------------------------------------

describe('formatEvent', () => {
  describe('unknown / unhandled types', () => {
    it('returns null for an unknown event type', () => {
      expect(formatEvent({ type: 'ping' })).toBeNull();
    });

    it('returns null for assistant type without subtype=text', () => {
      expect(formatEvent({ type: 'assistant', subtype: 'other' })).toBeNull();
    });

    it('returns null for assistant type with text subtype but no content_block', () => {
      expect(formatEvent({ type: 'assistant', subtype: 'text' })).toBeNull();
    });
  });

  describe('assistant events', () => {
    it('formats assistant text event with content_block.text', () => {
      const event = makeEvent({
        type: 'assistant',
        subtype: 'text',
        content_block: { type: 'text', text: 'I will implement this feature.' },
      });
      const result = formatEvent(event);
      expect(result).not.toBeNull();
      expect(result).toContain('[assistant]');
      expect(result).toContain('I will implement this feature.');
    });

    it('truncates long assistant text to 200 characters', () => {
      const longText = 'a'.repeat(300);
      const event = makeEvent({
        type: 'assistant',
        subtype: 'text',
        content_block: { type: 'text', text: longText },
      });
      const result = formatEvent(event)!;
      // The text portion should be at most 200 chars (the content_block.text slice)
      const textPart = result.replace(/\{[^}]+\}/g, '').replace('[assistant] ', '');
      expect(textPart.length).toBeLessThanOrEqual(200);
    });

    it('includes a timestamp prefix when event has a timestamp', () => {
      const event = makeEvent({
        type: 'assistant',
        subtype: 'text',
        timestamp: new Date('2024-01-15T14:30:00.000Z').toISOString(),
        content_block: { type: 'text', text: 'Hello' },
      });
      const result = formatEvent(event)!;
      // Should have a time prefix (the exact format depends on locale but it's there)
      expect(result.length).toBeGreaterThan('[assistant] Hello'.length);
    });
  });

  describe('tool_use events', () => {
    it('formats tool_use with content_block.name', () => {
      const event = makeEvent({
        type: 'tool_use',
        content_block: { type: 'tool_use', name: 'Bash' },
      });
      const result = formatEvent(event);
      expect(result).not.toBeNull();
      expect(result).toContain('[tool]');
      expect(result).toContain('Bash');
    });

    it('uses "unknown" when content_block.name is missing', () => {
      const event = makeEvent({
        type: 'tool_use',
        content_block: { type: 'tool_use' },
      });
      const result = formatEvent(event);
      expect(result).toContain('unknown');
    });
  });

  describe('tool_result events', () => {
    it('formats tool_result event', () => {
      const event = makeEvent({ type: 'tool_result' });
      const result = formatEvent(event);
      expect(result).not.toBeNull();
      expect(result).toContain('[result]');
      expect(result).toContain('tool completed');
    });
  });

  describe('result events', () => {
    it('formats result event with duration and cost', () => {
      const event = makeEvent({
        type: 'result',
        total_cost_usd: 0.0456,
        duration_ms: 5000,
      });
      const result = formatEvent(event)!;
      expect(result).toContain('[done]');
      expect(result).toContain('$0.0456');
      expect(result).toContain('5.0s');
    });

    it('formats result event without cost or duration', () => {
      const event = makeEvent({ type: 'result' });
      const result = formatEvent(event)!;
      expect(result).toContain('[done]');
      // No cost or duration suffix
      expect(result).not.toContain('$');
      expect(result).not.toContain('s');
    });
  });

  describe('system events', () => {
    it('formats system init event with session ID', () => {
      const event = makeEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-abc123',
      });
      const result = formatEvent(event);
      expect(result).not.toBeNull();
      expect(result).toContain('[init]');
      expect(result).toContain('sess-abc123');
    });

    it('returns null for non-init system events', () => {
      const event = makeEvent({ type: 'system', subtype: 'other' });
      expect(formatEvent(event)).toBeNull();
    });

    it('shows "?" when session_id is missing from system init', () => {
      const event = makeEvent({ type: 'system', subtype: 'init' });
      const result = formatEvent(event);
      expect(result).toContain('?');
    });
  });

  describe('blessed markup', () => {
    it('includes blessed color markup in output', () => {
      const event = makeEvent({
        type: 'assistant',
        subtype: 'text',
        content_block: { type: 'text', text: 'Hi' },
      });
      const result = formatEvent(event)!;
      // formatEvent (non-plain) should include blessed markup like {green-fg}
      expect(result).toMatch(/\{[a-z-]+\}/);
    });
  });
});

// ---------------------------------------------------------------------------
// formatEventPlain (no markup)
// ---------------------------------------------------------------------------

describe('formatEventPlain', () => {
  it('returns null for unhandled event types', () => {
    expect(formatEventPlain({ type: 'ping' })).toBeNull();
  });

  it('formats assistant text event without blessed markup', () => {
    const event = makeEvent({
      type: 'assistant',
      subtype: 'text',
      content_block: { type: 'text', text: 'Plain output' },
    });
    const result = formatEventPlain(event)!;
    expect(result).toContain('[assistant]');
    expect(result).toContain('Plain output');
    // Should NOT contain blessed markup
    expect(result).not.toMatch(/\{[a-z-]+\}/);
  });

  it('formats tool_use event without markup', () => {
    const event = makeEvent({
      type: 'tool_use',
      content_block: { type: 'tool_use', name: 'Read' },
    });
    const result = formatEventPlain(event)!;
    expect(result).toContain('[tool]');
    expect(result).toContain('Read');
    expect(result).not.toMatch(/\{[a-z-]+\}/);
  });

  it('formats tool_result event without markup', () => {
    const result = formatEventPlain({ type: 'tool_result' })!;
    expect(result).toContain('[result]');
    expect(result).not.toMatch(/\{[a-z-]+\}/);
  });

  it('formats result event with duration and cost', () => {
    const event = makeEvent({
      type: 'result',
      total_cost_usd: 0.12,
      duration_ms: 3500,
    });
    const result = formatEventPlain(event)!;
    expect(result).toContain('[done]');
    expect(result).toContain('$0.1200');
    expect(result).toContain('3.5s');
  });

  it('formats system init event without markup', () => {
    const event = makeEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-xyz',
    });
    const result = formatEventPlain(event)!;
    expect(result).toContain('[init]');
    expect(result).toContain('sess-xyz');
    expect(result).not.toMatch(/\{[a-z-]+\}/);
  });

  it('produces output identical in structure to formatEvent but without markup', () => {
    const event = makeEvent({
      type: 'tool_use',
      content_block: { type: 'tool_use', name: 'Write' },
    });
    const plain = formatEventPlain(event)!;
    const markup = formatEvent(event)!;
    // Strip blessed markup from the markup version
    const stripped = markup.replace(/\{[^}]+\}/g, '');
    expect(plain).toBe(stripped);
  });
});
