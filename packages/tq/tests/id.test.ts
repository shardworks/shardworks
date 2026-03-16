import { describe, it, expect } from 'vitest';
import { generateId, generateChildId } from '../src/id.js';

describe('generateId', () => {
  it('returns a string matching tq-XXXXXXXX format', () => {
    const id = generateId('test task', 'user-1', new Date('2024-01-01T00:00:00.000Z'));
    expect(id).toMatch(/^tq-[0-9a-f]{8}$/);
  });

  it('is deterministic for identical inputs', () => {
    const ts = new Date('2024-01-01T00:00:00.000Z');
    const id1 = generateId('test task', 'user-1', ts);
    const id2 = generateId('test task', 'user-1', ts);
    expect(id1).toBe(id2);
  });

  it('differs when description changes', () => {
    const ts = new Date('2024-01-01T00:00:00.000Z');
    const id1 = generateId('task A', 'user-1', ts);
    const id2 = generateId('task B', 'user-1', ts);
    expect(id1).not.toBe(id2);
  });

  it('differs when createdBy changes', () => {
    const ts = new Date('2024-01-01T00:00:00.000Z');
    const id1 = generateId('task', 'user-1', ts);
    const id2 = generateId('task', 'user-2', ts);
    expect(id1).not.toBe(id2);
  });

  it('differs when timestamp changes', () => {
    const id1 = generateId('task', 'user-1', new Date('2024-01-01T00:00:00.000Z'));
    const id2 = generateId('task', 'user-1', new Date('2024-01-02T00:00:00.000Z'));
    expect(id1).not.toBe(id2);
  });

  it('hash is always 8 hex characters', () => {
    for (let i = 0; i < 10; i++) {
      const id = generateId(`task ${i}`, 'user', new Date());
      const hash = id.replace('tq-', '');
      expect(hash).toHaveLength(8);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    }
  });
});

describe('generateChildId', () => {
  it('returns string formatted as "<parentId>.<hash>"', () => {
    const parentId = 'tq-abc12345';
    const id = generateChildId(parentId, 'child task', 'user-1', new Date('2024-01-01T00:00:00.000Z'));
    expect(id).toMatch(/^tq-abc12345\.[0-9a-f]{8}$/);
  });

  it('is deterministic for identical inputs', () => {
    const ts = new Date('2024-01-01T00:00:00.000Z');
    const parentId = 'tq-parent1';
    const id1 = generateChildId(parentId, 'child', 'user-1', ts);
    const id2 = generateChildId(parentId, 'child', 'user-1', ts);
    expect(id1).toBe(id2);
  });

  it('differs for different parent IDs', () => {
    const ts = new Date('2024-01-01T00:00:00.000Z');
    const id1 = generateChildId('tq-parent-1', 'child', 'user-1', ts);
    const id2 = generateChildId('tq-parent-2', 'child', 'user-1', ts);
    // Both should have different hash portions
    expect(id1.split('.')[1]).not.toBe(id2.split('.')[1]);
  });

  it('differs for different descriptions', () => {
    const ts = new Date('2024-01-01T00:00:00.000Z');
    const parent = 'tq-parent';
    const id1 = generateChildId(parent, 'child A', 'user-1', ts);
    const id2 = generateChildId(parent, 'child B', 'user-1', ts);
    expect(id1).not.toBe(id2);
  });

  it('produces a different ID than a top-level generateId with the same content', () => {
    const ts = new Date('2024-01-01T00:00:00.000Z');
    const topId = generateId('child', 'user-1', ts);
    const childId = generateChildId('tq-parent', 'child', 'user-1', ts);
    // The hash portion must differ (different inputs to SHA-256)
    expect(topId).not.toBe(childId);
  });

  it('prefixes the result with the parent ID and a dot', () => {
    const parentId = 'tq-11223344';
    const id = generateChildId(parentId, 'sub task', 'agent', new Date());
    expect(id.startsWith(`${parentId}.`)).toBe(true);
  });
});
