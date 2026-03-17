/**
 * Unit tests for tasks.ts — DB layer mocked via vi.mock.
 *
 * Strategy:
 * - `withCommit(msg, fn)` is intercepted to call `fn(mockConn)` directly.
 * - `pool.getConnection()` returns a shared `mockConn`.
 * - `mockConn.execute` is a vi.fn() whose return values are configured per-test
 *   using `.mockResolvedValueOnce()` in the order queries fire.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock objects — vi.hoisted ensures they exist when the vi.mock factory
// runs (vi.mock is hoisted above module-level code by Vitest).
// ---------------------------------------------------------------------------

const { mockExecute, mockRelease, mockConn } = vi.hoisted(() => {
  const mockExecute = vi.fn();
  const mockRelease = vi.fn();
  const mockConn = {
    execute: mockExecute,
    query: vi.fn().mockResolvedValue([[]]),
    release: mockRelease,
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
  };
  return { mockExecute, mockRelease, mockConn };
});

vi.mock('../src/db.js', () => ({
  pool: {
    getConnection: vi.fn().mockImplementation(() => Promise.resolve(mockConn)),
  },
  withCommit: vi.fn().mockImplementation(
    async (_msg: string, fn: (conn: unknown) => Promise<unknown>) => fn(mockConn),
  ),
  withTransaction: vi.fn().mockImplementation(
    async (conn: unknown, fn: (conn: unknown) => Promise<unknown>) => fn(conn),
  ),
}));

// Import tasks AFTER the mock is defined so it picks up the mocked db.
import {
  enqueue,
  getTask,
  listTasks,
  batchEnqueue,
  getMaxPriority,
  claim,
  publish,
  release,
  heartbeat,
  claimById,
} from '../src/tasks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DB row representing a task. */
function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tq-aabbccdd',
    description: 'test task',
    payload: null,
    status: 'draft',
    parent_id: null,
    priority: 0,
    result_payload: null,
    created_by: 'test-agent',
    claimed_by: null,
    assigned_role: null,
    max_attempts: 1,
    attempt_count: 0,
    timeout_seconds: null,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    eligible_at: null,
    claimed_at: null,
    completed_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
//
// IMPORTANT: We reset *only* the execute/release mocks (not pool.getConnection
// or withCommit) so that the module-level mock implementations remain intact.
// Using `mockReset()` (rather than `mockClear()`) ensures the
// `mockResolvedValueOnce` queue is drained between tests.
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExecute.mockReset();
  mockRelease.mockReset();
  // Provide a safe default: execute returns an empty result set unless overridden.
  mockExecute.mockResolvedValue([[]]);
});

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

describe('enqueue', () => {
  it('creates a top-level draft task with no dependencies', async () => {
    const task = await enqueue({
      description: 'Build the thing',
      created_by: 'agent-1',
      priority: 5,
    });

    expect(task.description).toBe('Build the thing');
    expect(task.created_by).toBe('agent-1');
    expect(task.priority).toBe(5);
    expect(task.status).toBe('draft');
    expect(task.parent_id).toBeNull();
    expect(task.dependencies).toEqual([]);
    expect(task.id).toMatch(/^tq-[0-9a-f]{8}$/);
  });

  it('creates task as eligible when skipDraft=true and no deps', async () => {
    const task = await enqueue({
      description: 'Quick task',
      created_by: 'agent-1',
      skipDraft: true,
    });

    expect(task.status).toBe('eligible');
    expect(task.eligible_at).not.toBeNull();
  });

  it('creates task as pending when skipDraft=true but has deps', async () => {
    // Dep validation: SELECT returns the dep row
    mockExecute.mockResolvedValueOnce([[{ id: 'tq-dep00001' }]]); // dep SELECT
    // INSERT tasks
    // INSERT task_dependencies

    const task = await enqueue({
      description: 'Task with dep',
      created_by: 'agent-1',
      skipDraft: true,
      dependencies: ['tq-dep00001'],
    });

    expect(task.status).toBe('pending');
    expect(task.dependencies).toEqual(['tq-dep00001']);
  });

  it('creates a child task when parent_id is provided', async () => {
    // Parent existence check: SELECT returns parent row
    mockExecute.mockResolvedValueOnce([[{ id: 'tq-parent1' }]]);

    const task = await enqueue({
      description: 'Child task',
      created_by: 'agent-1',
      parent_id: 'tq-parent1',
    });

    expect(task.parent_id).toBe('tq-parent1');
    expect(task.id).toMatch(/^tq-parent1\.[0-9a-f]{8}$/);
  });

  it('throws when a dependency ID does not exist in the DB', async () => {
    // SELECT returns only 1 of the 2 deps
    mockExecute.mockResolvedValueOnce([[{ id: 'tq-dep00001' }]]);

    await expect(
      enqueue({
        description: 'Bad task',
        created_by: 'agent-1',
        dependencies: ['tq-dep00001', 'tq-dep99999'],
      }),
    ).rejects.toThrow(/Unknown dependency IDs/);
  });

  it('throws when parent_id does not exist in the DB', async () => {
    mockExecute.mockResolvedValueOnce([[]]); // parent check: no rows

    await expect(
      enqueue({
        description: 'Orphan child',
        created_by: 'agent-1',
        parent_id: 'tq-nonexist',
      }),
    ).rejects.toThrow(/Parent task not found/);
  });

  it('JSON-serializes the payload before writing to DB', async () => {
    const capturedArgs: unknown[] = [];
    mockExecute.mockImplementation((_sql: string, args: unknown[]) => {
      capturedArgs.push(...(args ?? []));
      return Promise.resolve([[]]);
    });

    await enqueue({
      description: 'Payload task',
      created_by: 'agent-1',
      payload: { key: 'value', count: 42 },
    });

    // The payload should be JSON-stringified in the INSERT args
    const payloadArg = capturedArgs.find(
      a => typeof a === 'string' && a.includes('"key"'),
    );
    expect(payloadArg).toBe('{"key":"value","count":42}');
  });

  it('sets assigned_role when provided', async () => {
    const task = await enqueue({
      description: 'Role-scoped task',
      created_by: 'conductor-1',
      assigned_role: 'implementer',
    });

    expect(task.assigned_role).toBe('implementer');
  });
});

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

describe('getTask', () => {
  it('returns null when task does not exist', async () => {
    // attachDeps is never called when rows is empty, so only one execute call.
    mockExecute.mockResolvedValueOnce([[]]); // SELECT * FROM tasks: no rows

    const result = await getTask('tq-notfound');
    expect(result).toBeNull();
  });

  it('returns a Task when the task exists', async () => {
    const row = makeTaskRow({ id: 'tq-aabbccdd', description: 'Found it' });
    mockExecute
      .mockResolvedValueOnce([[row]])  // SELECT * FROM tasks
      .mockResolvedValueOnce([[]]); // task_dependencies: no deps

    const task = await getTask('tq-aabbccdd');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('tq-aabbccdd');
    expect(task!.description).toBe('Found it');
    expect(task!.dependencies).toEqual([]);
  });

  it('attaches dependency IDs when task has dependencies', async () => {
    const row = makeTaskRow({ id: 'tq-parent11' });
    mockExecute
      .mockResolvedValueOnce([[row]])  // SELECT * FROM tasks
      .mockResolvedValueOnce([[         // task_dependencies
        { task_id: 'tq-parent11', dep_id: 'tq-dep00001' },
        { task_id: 'tq-parent11', dep_id: 'tq-dep00002' },
      ]]);

    const task = await getTask('tq-parent11');
    expect(task!.dependencies).toEqual(['tq-dep00001', 'tq-dep00002']);
  });

  it('parses a JSON string payload into an object', async () => {
    const row = makeTaskRow({
      id: 'tq-jsontest',
      payload: '{"foo":"bar","n":1}',
    });
    mockExecute
      .mockResolvedValueOnce([[row]])
      .mockResolvedValueOnce([[]]);

    const task = await getTask('tq-jsontest');
    expect(task!.payload).toEqual({ foo: 'bar', n: 1 });
  });

  it('maps all standard task fields correctly', async () => {
    const now = new Date('2024-06-15T12:00:00.000Z');
    const row = makeTaskRow({
      id: 'tq-fieldtest',
      description: 'Field test',
      status: 'in_progress',
      priority: 10,
      created_by: 'runner-1',
      claimed_by: 'agent-abc',
      assigned_role: 'implementer',
      max_attempts: 3,
      attempt_count: 1,
      timeout_seconds: 600,
      created_at: now,
      eligible_at: now,
      claimed_at: now,
    });
    mockExecute
      .mockResolvedValueOnce([[row]])
      .mockResolvedValueOnce([[]]);

    const task = await getTask('tq-fieldtest');
    expect(task!.status).toBe('in_progress');
    expect(task!.priority).toBe(10);
    expect(task!.claimed_by).toBe('agent-abc');
    expect(task!.assigned_role).toBe('implementer');
    expect(task!.max_attempts).toBe(3);
    expect(task!.attempt_count).toBe(1);
    expect(task!.timeout_seconds).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// listTasks
// ---------------------------------------------------------------------------

describe('listTasks', () => {
  it('returns an empty array when no tasks match', async () => {
    // attachDeps short-circuits when taskIds is empty, so only one execute call.
    mockExecute.mockResolvedValueOnce([[]]); // SELECT tasks → no rows

    const tasks = await listTasks();
    expect(tasks).toEqual([]);
  });

  it('returns multiple tasks with their dependencies attached', async () => {
    const rows = [
      makeTaskRow({ id: 'tq-task0001', description: 'First' }),
      makeTaskRow({ id: 'tq-task0002', description: 'Second' }),
    ];
    mockExecute
      .mockResolvedValueOnce([rows])  // SELECT tasks
      .mockResolvedValueOnce([[       // attachDeps
        { task_id: 'tq-task0002', dep_id: 'tq-task0001' },
      ]]);

    const tasks = await listTasks();
    expect(tasks).toHaveLength(2);
    const first = tasks.find(t => t.id === 'tq-task0001');
    const second = tasks.find(t => t.id === 'tq-task0002');
    expect(first!.dependencies).toEqual([]);
    expect(second!.dependencies).toEqual(['tq-task0001']);
  });
});

// ---------------------------------------------------------------------------
// getMaxPriority
// ---------------------------------------------------------------------------

describe('getMaxPriority', () => {
  it('returns 0 when no tasks exist (COALESCE fallback)', async () => {
    mockExecute.mockResolvedValueOnce([[{ max_priority: 0 }]]);
    const max = await getMaxPriority();
    expect(max).toBe(0);
  });

  it('returns the maximum priority value from the DB', async () => {
    mockExecute.mockResolvedValueOnce([[{ max_priority: 42 }]]);
    const max = await getMaxPriority();
    expect(max).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// batchEnqueue
// ---------------------------------------------------------------------------

describe('batchEnqueue', () => {
  it('enqueues multiple independent tasks in a single commit', async () => {
    // Each task: INSERT INTO tasks (no external deps → no dep validation)
    const tasks = await batchEnqueue({
      created_by: 'agent-1',
      tasks: [
        { client_id: 'c1', description: 'Batch task 1' },
        { client_id: 'c2', description: 'Batch task 2' },
      ],
    });

    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.description)).toEqual(['Batch task 1', 'Batch task 2']);
  });

  it('enqueues all tasks as eligible when skipDraft=true and no deps', async () => {
    const tasks = await batchEnqueue({
      created_by: 'agent-1',
      skipDraft: true,
      tasks: [
        { client_id: 'c1', description: 'Ready task' },
      ],
    });

    expect(tasks[0]!.status).toBe('eligible');
  });

  it('enqueues sibling tasks respecting intra-batch dependency order', async () => {
    // task c2 depends on c1 (internal reference by client_id).
    // batchEnqueue must insert c1 before c2 and resolve c1's real ID for c2's dep.
    // No external dep validation needed (both are internal to the batch).
    const tasks = await batchEnqueue({
      created_by: 'agent-1',
      skipDraft: true,
      tasks: [
        { client_id: 'c1', description: 'Step 1' },
        { client_id: 'c2', description: 'Step 2', dependencies: ['c1'] },
      ],
    });

    expect(tasks).toHaveLength(2);
    const step1 = tasks.find(t => t.description === 'Step 1')!;
    const step2 = tasks.find(t => t.description === 'Step 2')!;
    // step2 should depend on step1's real generated ID
    expect(step2.dependencies).toContain(step1.id);
    // step2 has a dep so it should be pending (not eligible)
    expect(step2.status).toBe('pending');
    // step1 has no deps so it should be eligible
    expect(step1.status).toBe('eligible');
  });

  it('creates child tasks when parent_id is provided', async () => {
    // Each child task triggers a parent existence check
    mockExecute
      .mockResolvedValueOnce([[{ id: 'tq-parent01' }]]) // parent check for c1
      .mockResolvedValueOnce([[]])                        // INSERT c1
      .mockResolvedValueOnce([[{ id: 'tq-parent01' }]]) // parent check for c2
      .mockResolvedValueOnce([[]])                        // INSERT c2
      .mockResolvedValue([[]]); // fallback

    const tasks = await batchEnqueue({
      created_by: 'agent-1',
      tasks: [
        { client_id: 'c1', description: 'Child 1', parent_id: 'tq-parent01' },
        { client_id: 'c2', description: 'Child 2', parent_id: 'tq-parent01' },
      ],
    });

    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t.parent_id).toBe('tq-parent01');
      expect(t.id).toMatch(/^tq-parent01\.[0-9a-f]{8}$/);
    }
  });

  it('throws on cycle in intra-batch dependencies', async () => {
    await expect(
      batchEnqueue({
        created_by: 'agent-1',
        tasks: [
          { client_id: 'c1', description: 'A', dependencies: ['c2'] },
          { client_id: 'c2', description: 'B', dependencies: ['c1'] },
        ],
      }),
    ).rejects.toThrow(/Cycle detected/);
  });
});

// ---------------------------------------------------------------------------
// claim — role filter NULL fallback
// ---------------------------------------------------------------------------

describe('claim', () => {
  const now = new Date('2024-06-15T12:00:00.000Z');

  it('refiner with role=refiner claims draft task with assigned_role=NULL', async () => {
    // The SELECT query should use (assigned_role = ? OR assigned_role IS NULL)
    // for role=refiner, so a row with assigned_role=null is returned.
    const draftRow = makeTaskRow({
      id: 'tq-draft001',
      status: 'draft',
      assigned_role: null,
      claimed_at: now,
    });
    mockExecute
      .mockResolvedValueOnce([[draftRow]])  // SELECT ... FOR UPDATE
      .mockResolvedValueOnce([[]])          // UPDATE tasks SET status='in_progress'
      .mockResolvedValueOnce([[]]);         // attachDeps

    const result = await claim('refiner-agent', [], true, 'refiner');
    expect(result.task).not.toBeNull();
    expect(result.task!.id).toBe('tq-draft001');

    // Verify the SQL query used (assigned_role = ? OR assigned_role IS NULL)
    const selectCall = mockExecute.mock.calls[0];
    const sql: string = selectCall[0] as string;
    expect(sql).toMatch(/assigned_role = \? OR assigned_role IS NULL/);
  });

  it('implementer with role=implementer claims eligible task with assigned_role=NULL', async () => {
    const eligibleRow = makeTaskRow({
      id: 'tq-elig001',
      status: 'eligible',
      assigned_role: null,
      claimed_at: now,
    });
    mockExecute
      .mockResolvedValueOnce([[eligibleRow]])  // SELECT ... FOR UPDATE
      .mockResolvedValueOnce([[]])             // findEligibleLeaf — no children
      .mockResolvedValueOnce([[]])             // UPDATE tasks SET status='in_progress'
      .mockResolvedValueOnce([[]]);            // attachDeps

    const result = await claim('impl-agent', [], false, 'implementer');
    expect(result.task).not.toBeNull();
    expect(result.task!.id).toBe('tq-elig001');

    const selectCall = mockExecute.mock.calls[0];
    const sql: string = selectCall[0] as string;
    expect(sql).toMatch(/assigned_role = \? OR assigned_role IS NULL/);
  });

  it('planner with role=planner does NOT get NULL fallback (exact match only)', async () => {
    // SELECT returns empty — no planner-assigned tasks available.
    mockExecute.mockResolvedValueOnce([[]]); // SELECT ... FOR UPDATE

    const result = await claim('planner-agent', [], false, 'planner');
    expect(result.task).toBeNull();

    const selectCall = mockExecute.mock.calls[0];
    const sql: string = selectCall[0] as string;
    // Should be exact match, not the OR NULL pattern
    expect(sql).not.toMatch(/assigned_role = \? OR assigned_role IS NULL/);
    expect(sql).toMatch(/assigned_role = \?/);
  });
});

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

describe('publish', () => {
  it('draft in_progress → eligible when no deps', async () => {
    const row = makeTaskRow({
      id: 'tq-pub00001',
      status: 'in_progress',
      claimed_by: 'refiner-1',
    });
    mockExecute
      .mockResolvedValueOnce([[row]])  // SELECT * FROM tasks FOR UPDATE
      .mockResolvedValueOnce([[]])     // SELECT dep statuses (no deps)
      .mockResolvedValueOnce([[]])     // UPDATE tasks SET status, eligible_at, …
      .mockResolvedValueOnce([[]]);    // attachDeps

    const task = await publish('tq-pub00001', 'refiner-1');
    expect(task.status).toBe('eligible');
    expect(task.eligible_at).not.toBeNull();
    expect(task.claimed_by).toBeNull();
    expect(task.claimed_at).toBeNull();
  });

  it('draft in_progress → pending when pending deps exist', async () => {
    const row = makeTaskRow({
      id: 'tq-pub00002',
      status: 'in_progress',
      claimed_by: 'refiner-1',
    });
    mockExecute
      .mockResolvedValueOnce([[row]])                    // SELECT FOR UPDATE
      .mockResolvedValueOnce([[{ status: 'pending' }]]) // dep statuses: one pending dep
      .mockResolvedValueOnce([[]])                       // UPDATE tasks
      .mockResolvedValueOnce([[]]);                      // attachDeps

    const task = await publish('tq-pub00002', 'refiner-1');
    expect(task.status).toBe('pending');
    expect(task.eligible_at).toBeNull();
    expect(task.claimed_by).toBeNull();
  });

  it('draft in_progress → eligible when all deps are completed', async () => {
    const row = makeTaskRow({
      id: 'tq-pub00003',
      status: 'in_progress',
      claimed_by: 'refiner-1',
    });
    mockExecute
      .mockResolvedValueOnce([[row]])                      // SELECT FOR UPDATE
      .mockResolvedValueOnce([[{ status: 'completed' }]]) // dep statuses: all completed
      .mockResolvedValueOnce([[]])                         // UPDATE tasks
      .mockResolvedValueOnce([[]]);                        // attachDeps

    const task = await publish('tq-pub00003', 'refiner-1');
    expect(task.status).toBe('eligible');
    expect(task.eligible_at).not.toBeNull();
  });

  it('throws when task not found', async () => {
    mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows

    await expect(publish('tq-notfound', 'refiner-1')).rejects.toThrow(/Task not found/);
  });

  it('throws when status is not draft or in_progress', async () => {
    const row = makeTaskRow({ id: 'tq-pub00004', status: 'eligible' });
    mockExecute.mockResolvedValueOnce([[row]]);

    await expect(publish('tq-pub00004', 'refiner-1')).rejects.toThrow(/cannot be published/);
  });

  it('throws when in_progress but claimed_by does not match agentId', async () => {
    const row = makeTaskRow({
      id: 'tq-pub00005',
      status: 'in_progress',
      claimed_by: 'other-agent',
    });
    mockExecute.mockResolvedValueOnce([[row]]);

    await expect(publish('tq-pub00005', 'refiner-1')).rejects.toThrow(/not claimed by refiner-1/);
  });
});

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

describe('release', () => {
  it('happy path: sets status=eligible, clears claimed_by/claimed_at', async () => {
    const row = makeTaskRow({
      id: 'tq-rel00001',
      status: 'in_progress',
      claimed_by: 'agent-x',
    });
    mockExecute
      .mockResolvedValueOnce([[row]])  // SELECT FOR UPDATE
      .mockResolvedValueOnce([[]])     // UPDATE tasks SET status='eligible', …
      .mockResolvedValueOnce([[]]);    // attachDeps

    const task = await release('tq-rel00001', 'agent-x');
    expect(task.status).toBe('eligible');
    expect(task.claimed_by).toBeNull();
    expect(task.claimed_at).toBeNull();
    expect(task.eligible_at).not.toBeNull();
  });

  it('force=true: releases even when claimed_by does not match agentId', async () => {
    const row = makeTaskRow({
      id: 'tq-rel00002',
      status: 'in_progress',
      claimed_by: 'other-agent',
    });
    mockExecute
      .mockResolvedValueOnce([[row]])  // SELECT FOR UPDATE
      .mockResolvedValueOnce([[]])     // UPDATE
      .mockResolvedValueOnce([[]]);    // attachDeps

    const task = await release('tq-rel00002', 'agent-x', true /* force */);
    expect(task.status).toBe('eligible');
    expect(task.claimed_by).toBeNull();
  });

  it('throws when task not found', async () => {
    mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows

    await expect(release('tq-notfound', 'agent-x')).rejects.toThrow(/Task not found/);
  });

  it('throws when task is not in_progress', async () => {
    const row = makeTaskRow({ id: 'tq-rel00003', status: 'eligible' });
    mockExecute.mockResolvedValueOnce([[row]]);

    await expect(release('tq-rel00003', 'agent-x')).rejects.toThrow(/not in_progress/);
  });

  it('throws when claimed_by does not match agentId (without force)', async () => {
    const row = makeTaskRow({
      id: 'tq-rel00004',
      status: 'in_progress',
      claimed_by: 'other-agent',
    });
    mockExecute.mockResolvedValueOnce([[row]]);

    await expect(release('tq-rel00004', 'agent-x')).rejects.toThrow(/not claimed by agent-x/);
  });
});

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat', () => {
  it('happy path: updates claimed_at, returns updated task', async () => {
    const oldClaimedAt = new Date('2024-01-01T00:00:00.000Z');
    const row = makeTaskRow({
      id: 'tq-hb000001',
      status: 'in_progress',
      claimed_by: 'agent-y',
      claimed_at: oldClaimedAt,
    });
    mockExecute
      .mockResolvedValueOnce([[row]])  // SELECT FOR UPDATE
      .mockResolvedValueOnce([[]])     // UPDATE tasks SET claimed_at=?
      .mockResolvedValueOnce([[]]);    // attachDeps

    const task = await heartbeat('tq-hb000001', 'agent-y');
    expect(task.status).toBe('in_progress');
    expect(task.claimed_by).toBe('agent-y');
    // claimed_at should have been updated to a new date
    expect(task.claimed_at).not.toBeNull();
    expect(task.claimed_at).not.toEqual(oldClaimedAt);
  });

  it('throws when task not found', async () => {
    mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows

    await expect(heartbeat('tq-notfound', 'agent-y')).rejects.toThrow(/Task not found/);
  });

  it('throws when task is not in_progress', async () => {
    const row = makeTaskRow({ id: 'tq-hb000002', status: 'eligible' });
    mockExecute.mockResolvedValueOnce([[row]]);

    await expect(heartbeat('tq-hb000002', 'agent-y')).rejects.toThrow(/not in_progress/);
  });

  it('throws when claimed_by does not match agentId', async () => {
    const row = makeTaskRow({
      id: 'tq-hb000003',
      status: 'in_progress',
      claimed_by: 'other-agent',
    });
    mockExecute.mockResolvedValueOnce([[row]]);

    await expect(heartbeat('tq-hb000003', 'agent-y')).rejects.toThrow(/not claimed by agent-y/);
  });
});

// ---------------------------------------------------------------------------
// claimById
// ---------------------------------------------------------------------------

describe('claimById', () => {
  const now = new Date('2024-06-15T12:00:00.000Z');

  it('claims eligible task by ID', async () => {
    const row = makeTaskRow({
      id: 'tq-cb000001',
      status: 'eligible',
      assigned_role: null,
    });
    mockExecute
      .mockResolvedValueOnce([[row]])  // SELECT FOR UPDATE
      .mockResolvedValueOnce([[]])     // findEligibleLeaf: no children found
      .mockResolvedValueOnce([[]])     // UPDATE tasks SET status='in_progress'
      .mockResolvedValueOnce([[]]);    // attachDeps

    const result = await claimById('tq-cb000001', 'agent-z');
    expect(result.task).not.toBeNull();
    expect(result.task!.id).toBe('tq-cb000001');
    expect(result.task!.status).toBe('in_progress');
    expect(result.task!.claimed_by).toBe('agent-z');
  });

  it('claims draft task when draft=true', async () => {
    const row = makeTaskRow({
      id: 'tq-cb000002',
      status: 'draft',
      assigned_role: null,
    });
    mockExecute
      .mockResolvedValueOnce([[row]])  // SELECT FOR UPDATE (draft, so no findEligibleLeaf)
      .mockResolvedValueOnce([[]])     // UPDATE tasks SET status='in_progress'
      .mockResolvedValueOnce([[]]);    // attachDeps

    const result = await claimById('tq-cb000002', 'refiner-1', true /* draft=true */);
    expect(result.task).not.toBeNull();
    expect(result.task!.id).toBe('tq-cb000002');
    expect(result.task!.status).toBe('in_progress');
    expect(result.task!.claimed_by).toBe('refiner-1');
  });

  it('follows eligible leaf delegation to child task', async () => {
    const parentRow = makeTaskRow({
      id: 'tq-cb000003',
      status: 'eligible',
      assigned_role: null,
    });
    const childRow = makeTaskRow({
      id: 'tq-cb000003.child01',
      status: 'eligible',
      parent_id: 'tq-cb000003',
      assigned_role: null,
    });
    mockExecute
      .mockResolvedValueOnce([[parentRow]])  // SELECT FOR UPDATE (parent)
      .mockResolvedValueOnce([[childRow]])   // findEligibleLeaf: child found
      .mockResolvedValueOnce([[]])           // findEligibleLeaf recursive: no deeper child
      .mockResolvedValueOnce([[]])           // UPDATE tasks SET status='in_progress'
      .mockResolvedValueOnce([[]]);          // attachDeps

    const result = await claimById('tq-cb000003', 'agent-z');
    expect(result.task).not.toBeNull();
    // Should have claimed the child, not the parent
    expect(result.task!.id).toBe('tq-cb000003.child01');
    expect(result.task!.status).toBe('in_progress');
  });

  it('throws when task not found', async () => {
    mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows

    await expect(claimById('tq-notfound', 'agent-z')).rejects.toThrow(/Task not found/);
  });

  it('throws when task status is not eligible (or draft when draft=false)', async () => {
    const row = makeTaskRow({ id: 'tq-cb000004', status: 'in_progress' });
    mockExecute.mockResolvedValueOnce([[row]]);

    await expect(claimById('tq-cb000004', 'agent-z')).rejects.toThrow(/cannot be claimed/);
  });

  it('throws when task is draft and draft=false', async () => {
    const row = makeTaskRow({ id: 'tq-cb000005', status: 'draft' });
    mockExecute.mockResolvedValueOnce([[row]]);

    await expect(claimById('tq-cb000005', 'agent-z', false /* draft=false */)).rejects.toThrow(
      /cannot be claimed/,
    );
  });
});
