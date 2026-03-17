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
    withCommit: vi.fn().mockImplementation(async (_msg, fn) => fn(mockConn)),
    withTransaction: vi.fn().mockImplementation(async (conn, fn) => fn(conn)),
}));
// Import tasks AFTER the mock is defined so it picks up the mocked db.
import { enqueue, getTask, listTasks, batchEnqueue, getMaxPriority, claim, publish, release, heartbeat, claimById, complete, fail, link, unlink, reparent, edit, cancel, retryTask, reap, releaseTimedOut, compact, subtree, ready, } from '../src/tasks.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Build a minimal DB row representing a task. */
function makeTaskRow(overrides = {}) {
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
        expect(task.id).toMatch(/^tq-[0-9a-f]{12}$/);
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
        expect(task.id).toMatch(/^tq-parent1\.[0-9a-f]{12}$/);
    });
    it('throws when a dependency ID does not exist in the DB', async () => {
        // SELECT returns only 1 of the 2 deps
        mockExecute.mockResolvedValueOnce([[{ id: 'tq-dep00001' }]]);
        await expect(enqueue({
            description: 'Bad task',
            created_by: 'agent-1',
            dependencies: ['tq-dep00001', 'tq-dep99999'],
        })).rejects.toThrow(/Unknown dependency IDs/);
    });
    it('throws when parent_id does not exist in the DB', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // parent check: no rows
        await expect(enqueue({
            description: 'Orphan child',
            created_by: 'agent-1',
            parent_id: 'tq-nonexist',
        })).rejects.toThrow(/Parent task not found/);
    });
    it('JSON-serializes the payload before writing to DB', async () => {
        const capturedArgs = [];
        mockExecute.mockImplementation((_sql, args) => {
            capturedArgs.push(...(args ?? []));
            return Promise.resolve([[]]);
        });
        await enqueue({
            description: 'Payload task',
            created_by: 'agent-1',
            payload: { key: 'value', count: 42 },
        });
        // The payload should be JSON-stringified in the INSERT args
        const payloadArg = capturedArgs.find(a => typeof a === 'string' && a.includes('"key"'));
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
            .mockResolvedValueOnce([[row]]) // SELECT * FROM tasks
            .mockResolvedValueOnce([[]]); // task_dependencies: no deps
        const task = await getTask('tq-aabbccdd');
        expect(task).not.toBeNull();
        expect(task.id).toBe('tq-aabbccdd');
        expect(task.description).toBe('Found it');
        expect(task.dependencies).toEqual([]);
    });
    it('attaches dependency IDs when task has dependencies', async () => {
        const row = makeTaskRow({ id: 'tq-parent11' });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT * FROM tasks
            .mockResolvedValueOnce([[
                { task_id: 'tq-parent11', dep_id: 'tq-dep00001' },
                { task_id: 'tq-parent11', dep_id: 'tq-dep00002' },
            ]]);
        const task = await getTask('tq-parent11');
        expect(task.dependencies).toEqual(['tq-dep00001', 'tq-dep00002']);
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
        expect(task.payload).toEqual({ foo: 'bar', n: 1 });
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
        expect(task.status).toBe('in_progress');
        expect(task.priority).toBe(10);
        expect(task.claimed_by).toBe('agent-abc');
        expect(task.assigned_role).toBe('implementer');
        expect(task.max_attempts).toBe(3);
        expect(task.attempt_count).toBe(1);
        expect(task.timeout_seconds).toBe(600);
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
            .mockResolvedValueOnce([rows]) // SELECT tasks
            .mockResolvedValueOnce([[
                { task_id: 'tq-task0002', dep_id: 'tq-task0001' },
            ]]);
        const tasks = await listTasks();
        expect(tasks).toHaveLength(2);
        const first = tasks.find(t => t.id === 'tq-task0001');
        const second = tasks.find(t => t.id === 'tq-task0002');
        expect(first.dependencies).toEqual([]);
        expect(second.dependencies).toEqual(['tq-task0001']);
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
        expect(tasks[0].status).toBe('eligible');
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
        const step1 = tasks.find(t => t.description === 'Step 1');
        const step2 = tasks.find(t => t.description === 'Step 2');
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
            .mockResolvedValueOnce([[]]) // INSERT c1
            .mockResolvedValueOnce([[{ id: 'tq-parent01' }]]) // parent check for c2
            .mockResolvedValueOnce([[]]) // INSERT c2
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
            expect(t.id).toMatch(/^tq-parent01\.[0-9a-f]{12}$/);
        }
    });
    it('throws on cycle in intra-batch dependencies', async () => {
        await expect(batchEnqueue({
            created_by: 'agent-1',
            tasks: [
                { client_id: 'c1', description: 'A', dependencies: ['c2'] },
                { client_id: 'c2', description: 'B', dependencies: ['c1'] },
            ],
        })).rejects.toThrow(/Cycle detected/);
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
            .mockResolvedValueOnce([[draftRow]]) // SELECT ... FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='in_progress'
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await claim('refiner-agent', [], true, 'refiner');
        expect(result.task).not.toBeNull();
        expect(result.task.id).toBe('tq-draft001');
        // Verify the SQL query used (assigned_role = ? OR assigned_role IS NULL)
        const selectCall = mockExecute.mock.calls[0];
        const sql = selectCall[0];
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
            .mockResolvedValueOnce([[eligibleRow]]) // SELECT ... FOR UPDATE
            .mockResolvedValueOnce([[]]) // findEligibleLeaf — no children
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='in_progress'
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await claim('impl-agent', [], false, 'implementer');
        expect(result.task).not.toBeNull();
        expect(result.task.id).toBe('tq-elig001');
        const selectCall = mockExecute.mock.calls[0];
        const sql = selectCall[0];
        expect(sql).toMatch(/assigned_role = \? OR assigned_role IS NULL/);
    });
    it('planner with role=planner does NOT get NULL fallback (exact match only)', async () => {
        // SELECT returns empty — no planner-assigned tasks available.
        mockExecute.mockResolvedValueOnce([[]]); // SELECT ... FOR UPDATE
        const result = await claim('planner-agent', [], false, 'planner');
        expect(result.task).toBeNull();
        const selectCall = mockExecute.mock.calls[0];
        const sql = selectCall[0];
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
            .mockResolvedValueOnce([[row]]) // SELECT * FROM tasks FOR UPDATE
            .mockResolvedValueOnce([[]]) // SELECT dep statuses (no deps)
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status, eligible_at, …
            .mockResolvedValueOnce([[]]); // attachDeps
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
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[{ status: 'pending' }]]) // dep statuses: one pending dep
            .mockResolvedValueOnce([[]]) // UPDATE tasks
            .mockResolvedValueOnce([[]]); // attachDeps
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
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[{ status: 'completed' }]]) // dep statuses: all completed
            .mockResolvedValueOnce([[]]) // UPDATE tasks
            .mockResolvedValueOnce([[]]); // attachDeps
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
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='eligible', …
            .mockResolvedValueOnce([[]]); // attachDeps
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
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE
            .mockResolvedValueOnce([[]]); // attachDeps
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
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET claimed_at=?
            .mockResolvedValueOnce([[]]); // attachDeps
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
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // findEligibleLeaf: no children found
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='in_progress'
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await claimById('tq-cb000001', 'agent-z');
        expect(result.task).not.toBeNull();
        expect(result.task.id).toBe('tq-cb000001');
        expect(result.task.status).toBe('in_progress');
        expect(result.task.claimed_by).toBe('agent-z');
    });
    it('claims draft task when draft=true', async () => {
        const row = makeTaskRow({
            id: 'tq-cb000002',
            status: 'draft',
            assigned_role: null,
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE (draft, so no findEligibleLeaf)
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='in_progress'
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await claimById('tq-cb000002', 'refiner-1', true /* draft=true */);
        expect(result.task).not.toBeNull();
        expect(result.task.id).toBe('tq-cb000002');
        expect(result.task.status).toBe('in_progress');
        expect(result.task.claimed_by).toBe('refiner-1');
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
            .mockResolvedValueOnce([[parentRow]]) // SELECT FOR UPDATE (parent)
            .mockResolvedValueOnce([[childRow]]) // findEligibleLeaf: child found
            .mockResolvedValueOnce([[]]) // findEligibleLeaf recursive: no deeper child
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='in_progress'
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await claimById('tq-cb000003', 'agent-z');
        expect(result.task).not.toBeNull();
        // Should have claimed the child, not the parent
        expect(result.task.id).toBe('tq-cb000003.child01');
        expect(result.task.status).toBe('in_progress');
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
        await expect(claimById('tq-cb000005', 'agent-z', false /* draft=false */)).rejects.toThrow(/cannot be claimed/);
    });
});
// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------
describe('complete', () => {
    it('marks task completed with result payload and promotes eligible dependents', async () => {
        const row = makeTaskRow({
            id: 'tq-cmp00001',
            status: 'in_progress',
            claimed_by: 'agent-1',
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='completed'
            // promoteEligible: check direct dependents — no dependents
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await complete('tq-cmp00001', 'agent-1', { result: 42 });
        expect(task.status).toBe('completed');
        expect(task.completed_at).not.toBeNull();
        expect(task.result_payload).toEqual({ result: 42 });
    });
    it('promotes a pending dependent to eligible when its only dep completes', async () => {
        const row = makeTaskRow({
            id: 'tq-cmp00002',
            status: 'in_progress',
            claimed_by: 'agent-1',
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='completed'
            // promoteEligible: one candidate depends on this task
            .mockResolvedValueOnce([[{ task_id: 'tq-dep00002' }]]) // dependents
            // check if all deps of 'tq-dep00002' are completed
            .mockResolvedValueOnce([[{ status: 'completed' }]]) // all deps done
            .mockResolvedValueOnce([[]]) // UPDATE eligible for tq-dep00002
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await complete('tq-cmp00002', 'agent-1');
        expect(task.status).toBe('completed');
        // The UPDATE to promote the dependent should have been called
        const updateCalls = mockExecute.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes("status = 'eligible'"));
        expect(updateCalls.length).toBeGreaterThan(0);
    });
    it('does NOT promote a dependent that still has incomplete deps', async () => {
        const row = makeTaskRow({
            id: 'tq-cmp00003',
            status: 'in_progress',
            claimed_by: 'agent-1',
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='completed'
            // promoteEligible: one candidate
            .mockResolvedValueOnce([[{ task_id: 'tq-dep00003' }]])
            // candidate has an incomplete dep (pending)
            .mockResolvedValueOnce([[{ status: 'pending' }]])
            // No UPDATE expected for the dependent
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await complete('tq-cmp00003', 'agent-1');
        expect(task.status).toBe('completed');
        // No 'eligible' update should have been fired for the dependent
        const eligibleUpdates = mockExecute.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes("status = 'eligible'") && sql.includes('pending'));
        expect(eligibleUpdates.length).toBe(0);
    });
    it('throws when task not found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows
        await expect(complete('tq-notfound', 'agent-1')).rejects.toThrow(/Task not found/);
    });
    it('throws when task is not in_progress', async () => {
        const row = makeTaskRow({ id: 'tq-cmp00004', status: 'eligible' });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(complete('tq-cmp00004', 'agent-1')).rejects.toThrow(/not in_progress/);
    });
    it('throws when claimed_by does not match agentId', async () => {
        const row = makeTaskRow({
            id: 'tq-cmp00005',
            status: 'in_progress',
            claimed_by: 'other-agent',
        });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(complete('tq-cmp00005', 'agent-1')).rejects.toThrow(/not claimed by agent-1/);
    });
});
// ---------------------------------------------------------------------------
// fail
// ---------------------------------------------------------------------------
describe('fail', () => {
    it('fails terminally when max_attempts is reached', async () => {
        const row = makeTaskRow({
            id: 'tq-fail0001',
            status: 'in_progress',
            claimed_by: 'agent-1',
            max_attempts: 1,
            attempt_count: 0,
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='failed'
            // cascadeBlocked: no dependents
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await fail('tq-fail0001', 'agent-1', 'something broke');
        expect(task.status).toBe('failed');
        expect(task.completed_at).not.toBeNull();
        expect(task.result_payload.error).toBe('something broke');
    });
    it('retries (returns to eligible) when attempts remain', async () => {
        const row = makeTaskRow({
            id: 'tq-fail0002',
            status: 'in_progress',
            claimed_by: 'agent-1',
            max_attempts: 3,
            attempt_count: 0,
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='eligible'
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await fail('tq-fail0002', 'agent-1', 'temporary error');
        expect(task.status).toBe('eligible');
        expect(task.claimed_by).toBeNull();
        expect(task.attempt_count).toBe(1);
        expect(task.result_payload.retrying).toBe(true);
    });
    it('cascades blocked status to dependents on terminal failure', async () => {
        const row = makeTaskRow({
            id: 'tq-fail0003',
            status: 'in_progress',
            claimed_by: 'agent-1',
            max_attempts: 1,
            attempt_count: 0,
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='failed'
            // cascadeBlocked: one direct dependent
            .mockResolvedValueOnce([[{ task_id: 'tq-dep00001' }]])
            .mockResolvedValueOnce([[]]) // UPDATE blocked for tq-dep00001
            // cascadeBlocked recursive: no further dependents
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await fail('tq-fail0003', 'agent-1', 'critical failure');
        expect(task.status).toBe('failed');
        // Verify cascadeBlocked fired an UPDATE for the dependent
        const blockUpdates = mockExecute.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes("status = 'blocked'"));
        expect(blockUpdates.length).toBe(1);
    });
    it('throws when task not found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows
        await expect(fail('tq-notfound', 'agent-1', 'reason')).rejects.toThrow(/Task not found/);
    });
    it('throws when task is not in_progress', async () => {
        const row = makeTaskRow({ id: 'tq-fail0004', status: 'eligible' });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(fail('tq-fail0004', 'agent-1', 'reason')).rejects.toThrow(/not in_progress/);
    });
    it('throws when claimed_by does not match agentId', async () => {
        const row = makeTaskRow({
            id: 'tq-fail0005',
            status: 'in_progress',
            claimed_by: 'other-agent',
        });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(fail('tq-fail0005', 'agent-1', 'reason')).rejects.toThrow(/not claimed by agent-1/);
    });
});
// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------
describe('link', () => {
    it('adds a dependency edge between two tasks', async () => {
        const taskRow = makeTaskRow({ id: 'tq-lnk00001', status: 'pending' });
        const depRow = makeTaskRow({ id: 'tq-lnk00002', status: 'eligible' });
        mockExecute
            .mockResolvedValueOnce([[taskRow, depRow]]) // SELECT both FOR UPDATE
            .mockResolvedValueOnce([[]]) // SELECT existing edge — none
            // reachableFrom: SELECT from tq-lnk00002 — no outgoing deps
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]) // INSERT task_dependencies
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await link('tq-lnk00001', 'tq-lnk00002', 'planner-1');
        expect(task.id).toBe('tq-lnk00001');
        const insertCalls = mockExecute.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO task_dependencies'));
        expect(insertCalls.length).toBe(1);
    });
    it('demotes eligible task to pending when new incomplete dep added', async () => {
        const taskRow = makeTaskRow({ id: 'tq-lnk00003', status: 'eligible' });
        const depRow = makeTaskRow({ id: 'tq-lnk00004', status: 'eligible' }); // incomplete dep
        mockExecute
            .mockResolvedValueOnce([[taskRow, depRow]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // existing edge check — none
            .mockResolvedValueOnce([[]]) // reachableFrom — no cycle
            .mockResolvedValueOnce([[]]) // INSERT
            .mockResolvedValueOnce([[]]) // UPDATE pending (demotion)
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await link('tq-lnk00003', 'tq-lnk00004', 'planner-1');
        expect(task.status).toBe('pending');
        const demoteCalls = mockExecute.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes("status = 'pending'"));
        expect(demoteCalls.length).toBeGreaterThan(0);
    });
    it('does NOT demote eligible task when new dep is already completed', async () => {
        const taskRow = makeTaskRow({ id: 'tq-lnk00005', status: 'eligible' });
        const depRow = makeTaskRow({ id: 'tq-lnk00006', status: 'completed' }); // completed dep
        mockExecute
            .mockResolvedValueOnce([[taskRow, depRow]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // existing edge — none
            .mockResolvedValueOnce([[]]) // reachableFrom
            .mockResolvedValueOnce([[]]) // INSERT
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await link('tq-lnk00005', 'tq-lnk00006', 'planner-1');
        expect(task.status).toBe('eligible');
    });
    it('throws when adding edge would create a cycle', async () => {
        const taskRow = makeTaskRow({ id: 'tq-lnk00007', status: 'pending' });
        const depRow = makeTaskRow({ id: 'tq-lnk00008', status: 'pending' });
        mockExecute
            .mockResolvedValueOnce([[taskRow, depRow]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // existing edge — none
            // reachableFrom returns tq-lnk00007 itself (cycle!)
            .mockResolvedValueOnce([[{ dep_id: 'tq-lnk00007' }]]) // tq-lnk00007 reachable from tq-lnk00008
            .mockResolvedValueOnce([[]]) // recursion stop
        ;
        await expect(link('tq-lnk00007', 'tq-lnk00008', 'planner-1')).rejects.toThrow(/cycle/i);
    });
    it('throws when task not found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows
        await expect(link('tq-notfound', 'tq-dep00001', 'planner-1')).rejects.toThrow(/Task not found/);
    });
    it('throws when task status is not mutable (in_progress)', async () => {
        const taskRow = makeTaskRow({ id: 'tq-lnk00009', status: 'in_progress' });
        const depRow = makeTaskRow({ id: 'tq-lnk00010', status: 'eligible' });
        mockExecute.mockResolvedValueOnce([[taskRow, depRow]]);
        await expect(link('tq-lnk00009', 'tq-lnk00010', 'planner-1')).rejects.toThrow(/Cannot add dependency/);
    });
    it('throws when edge already exists', async () => {
        const taskRow = makeTaskRow({ id: 'tq-lnk00011', status: 'pending' });
        const depRow = makeTaskRow({ id: 'tq-lnk00012', status: 'eligible' });
        mockExecute
            .mockResolvedValueOnce([[taskRow, depRow]])
            .mockResolvedValueOnce([[{ 1: 1 }]]); // existing edge found
        await expect(link('tq-lnk00011', 'tq-lnk00012', 'planner-1')).rejects.toThrow(/already exists/);
    });
});
// ---------------------------------------------------------------------------
// unlink
// ---------------------------------------------------------------------------
describe('unlink', () => {
    it('removes an existing dependency edge', async () => {
        const row = makeTaskRow({ id: 'tq-unl00001', status: 'pending' });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[{ 1: 1 }]]) // existing edge check — found
            .mockResolvedValueOnce([[]]) // DELETE
            // pending → eligible check: no remaining deps
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]) // UPDATE eligible
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await unlink('tq-unl00001', 'tq-dep00001', 'planner-1');
        expect(task.id).toBe('tq-unl00001');
        const deleteCalls = mockExecute.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM task_dependencies'));
        expect(deleteCalls.length).toBe(1);
    });
    it('promotes pending task to eligible when all remaining deps are completed', async () => {
        const row = makeTaskRow({ id: 'tq-unl00002', status: 'pending' });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[{ 1: 1 }]]) // existing edge — found
            .mockResolvedValueOnce([[]]) // DELETE
            // remaining deps: one completed
            .mockResolvedValueOnce([[{ status: 'completed' }]])
            .mockResolvedValueOnce([[]]) // UPDATE eligible
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await unlink('tq-unl00002', 'tq-dep00002', 'planner-1');
        expect(task.status).toBe('eligible');
    });
    it('does NOT promote pending task when remaining deps are incomplete', async () => {
        const row = makeTaskRow({ id: 'tq-unl00003', status: 'pending' });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[{ 1: 1 }]]) // existing edge — found
            .mockResolvedValueOnce([[]]) // DELETE
            // remaining deps: still pending
            .mockResolvedValueOnce([[{ status: 'pending' }]])
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await unlink('tq-unl00003', 'tq-dep00003', 'planner-1');
        expect(task.status).toBe('pending');
    });
    it('throws when task not found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows
        await expect(unlink('tq-notfound', 'tq-dep00001', 'planner-1')).rejects.toThrow(/Task not found/);
    });
    it('throws when task status is not mutable (completed)', async () => {
        const row = makeTaskRow({ id: 'tq-unl00004', status: 'completed' });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(unlink('tq-unl00004', 'tq-dep00001', 'planner-1')).rejects.toThrow(/Cannot remove dependency/);
    });
    it('throws when dependency edge does not exist', async () => {
        const row = makeTaskRow({ id: 'tq-unl00005', status: 'pending' });
        mockExecute
            .mockResolvedValueOnce([[row]])
            .mockResolvedValueOnce([[]]); // no existing edge
        await expect(unlink('tq-unl00005', 'tq-dep99999', 'planner-1')).rejects.toThrow(/No dependency/);
    });
});
// ---------------------------------------------------------------------------
// reparent
// ---------------------------------------------------------------------------
describe('reparent', () => {
    it('moves a task under a new parent', async () => {
        const row = makeTaskRow({ id: 'tq-rep00001', status: 'draft', parent_id: null });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT task FOR UPDATE
            .mockResolvedValueOnce([[{ id: 'tq-rep00002' }]]) // SELECT new parent — exists
            // getParentId for circular check: new parent has no parent
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]) // UPDATE parent_id
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await reparent('tq-rep00001', 'tq-rep00002', 'planner-1');
        expect(task.parent_id).toBe('tq-rep00002');
    });
    it('moves a task to root (null parent)', async () => {
        const row = makeTaskRow({ id: 'tq-rep00003', status: 'draft', parent_id: 'tq-rep00004' });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT task FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE parent_id = NULL
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await reparent('tq-rep00003', null, 'planner-1');
        expect(task.parent_id).toBeNull();
    });
    it('throws when task not found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows
        await expect(reparent('tq-notfound', null, 'planner-1')).rejects.toThrow(/Task not found/);
    });
    it('throws when new parent not found', async () => {
        const row = makeTaskRow({ id: 'tq-rep00005', status: 'draft' });
        mockExecute
            .mockResolvedValueOnce([[row]])
            .mockResolvedValueOnce([[]]); // parent check: not found
        await expect(reparent('tq-rep00005', 'tq-noparent', 'planner-1')).rejects.toThrow(/Parent task not found/);
    });
    it('throws when reparenting would create a circular parent chain', async () => {
        // tq-rep00006 wants to move under tq-rep00007, but tq-rep00007's parent is tq-rep00006
        const row = makeTaskRow({ id: 'tq-rep00006', status: 'draft' });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT task FOR UPDATE
            .mockResolvedValueOnce([[{ id: 'tq-rep00007' }]]) // new parent found
            // circular check: walk up from tq-rep00007 → parent is tq-rep00006
            .mockResolvedValueOnce([[{ parent_id: 'tq-rep00006' }]]);
        await expect(reparent('tq-rep00006', 'tq-rep00007', 'planner-1')).rejects.toThrow(/circular/i);
    });
});
// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------
describe('edit', () => {
    it('updates description of a draft task', async () => {
        const row = makeTaskRow({ id: 'tq-edt00001', status: 'draft', description: 'old description' });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET description=?
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await edit('tq-edt00001', 'planner-1', { description: 'new description' });
        expect(task.description).toBe('new description');
    });
    it('updates priority and payload together', async () => {
        const row = makeTaskRow({ id: 'tq-edt00002', status: 'eligible', priority: 5 });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await edit('tq-edt00002', 'planner-1', {
            priority: 10,
            payload: { step: 'final' },
        });
        expect(task.priority).toBe(10);
        expect(task.payload).toEqual({ step: 'final' });
    });
    it('updates assigned_role', async () => {
        const row = makeTaskRow({ id: 'tq-edt00003', status: 'draft', assigned_role: null });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await edit('tq-edt00003', 'planner-1', { assigned_role: 'implementer' });
        expect(task.assigned_role).toBe('implementer');
    });
    it('throws when no updates provided', async () => {
        await expect(edit('tq-edt00004', 'planner-1', {})).rejects.toThrow(/At least one of/);
    });
    it('throws when task not found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows
        await expect(edit('tq-edt00005', 'planner-1', { priority: 10 })).rejects.toThrow(/Task not found/);
    });
    it('throws when task status is not mutable (in_progress)', async () => {
        const row = makeTaskRow({ id: 'tq-edt00006', status: 'in_progress' });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(edit('tq-edt00006', 'planner-1', { priority: 10 })).rejects.toThrow(/Cannot edit/);
    });
});
// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------
describe('cancel', () => {
    it('cancels a draft task', async () => {
        const row = makeTaskRow({ id: 'tq-cnl00001', status: 'draft' });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='cancelled'
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await cancel('tq-cnl00001', 'planner-1', 'duplicate task');
        expect(task.status).toBe('cancelled');
        expect(task.completed_at).not.toBeNull();
        const result = task.result_payload;
        expect(result.cancelled).toBe(true);
        expect(result.cancelled_by).toBe('planner-1');
        expect(result.reason).toBe('duplicate task');
    });
    it('cancels an eligible task', async () => {
        const row = makeTaskRow({ id: 'tq-cnl00002', status: 'eligible' });
        mockExecute
            .mockResolvedValueOnce([[row]])
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]);
        const task = await cancel('tq-cnl00002', 'planner-1', 'no longer needed');
        expect(task.status).toBe('cancelled');
    });
    it('cancels a pending task', async () => {
        const row = makeTaskRow({ id: 'tq-cnl00003', status: 'pending' });
        mockExecute
            .mockResolvedValueOnce([[row]])
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]);
        const task = await cancel('tq-cnl00003', 'planner-1', 'wrong task');
        expect(task.status).toBe('cancelled');
    });
    it('throws when task is in_progress', async () => {
        const row = makeTaskRow({
            id: 'tq-cnl00004',
            status: 'in_progress',
            claimed_by: 'agent-x',
        });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(cancel('tq-cnl00004', 'planner-1', 'reason')).rejects.toThrow(/in_progress/);
    });
    it('throws when task is already completed', async () => {
        const row = makeTaskRow({ id: 'tq-cnl00005', status: 'completed' });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(cancel('tq-cnl00005', 'planner-1', 'reason')).rejects.toThrow(/already completed/);
    });
    it('throws when task is already failed', async () => {
        const row = makeTaskRow({ id: 'tq-cnl00006', status: 'failed' });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(cancel('tq-cnl00006', 'planner-1', 'reason')).rejects.toThrow(/already failed/);
    });
    it('throws when task is already cancelled', async () => {
        const row = makeTaskRow({ id: 'tq-cnl00007', status: 'cancelled' });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(cancel('tq-cnl00007', 'planner-1', 'reason')).rejects.toThrow(/already cancelled/);
    });
    it('throws when task not found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows
        await expect(cancel('tq-notfound', 'planner-1', 'reason')).rejects.toThrow(/Task not found/);
    });
});
// ---------------------------------------------------------------------------
// retryTask
// ---------------------------------------------------------------------------
describe('retryTask', () => {
    it('re-queues a failed task as eligible when all deps are completed', async () => {
        const row = makeTaskRow({
            id: 'tq-rtr00001',
            status: 'failed',
            attempt_count: 1,
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            // dep status check: all deps completed
            .mockResolvedValueOnce([[{ status: 'completed' }]])
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='eligible'
            // promoteUnblocked: no tasks depend on this one
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await retryTask('tq-rtr00001', 'planner-1');
        expect(task.status).toBe('eligible');
        expect(task.attempt_count).toBe(0);
        expect(task.result_payload).toBeNull();
        expect(task.completed_at).toBeNull();
    });
    it('re-queues a failed task as pending when deps are not completed', async () => {
        const row = makeTaskRow({
            id: 'tq-rtr00002',
            status: 'failed',
            attempt_count: 2,
        });
        mockExecute
            .mockResolvedValueOnce([[row]])
            // dep status: still pending
            .mockResolvedValueOnce([[{ status: 'pending' }]])
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='pending'
            // promoteUnblocked: no downstream blocked tasks
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await retryTask('tq-rtr00002', 'planner-1');
        expect(task.status).toBe('pending');
        expect(task.attempt_count).toBe(0);
    });
    it('re-queues a blocked task', async () => {
        const row = makeTaskRow({ id: 'tq-rtr00003', status: 'blocked' });
        mockExecute
            .mockResolvedValueOnce([[row]])
            .mockResolvedValueOnce([[]]) // dep check: no deps (all done)
            .mockResolvedValueOnce([[]]) // UPDATE eligible
            .mockResolvedValueOnce([[]]) // promoteUnblocked
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await retryTask('tq-rtr00003', 'planner-1');
        expect(task.status).toBe('eligible');
    });
    it('un-blocks dependent tasks that were blocked by this task', async () => {
        const row = makeTaskRow({ id: 'tq-rtr00004', status: 'failed' });
        mockExecute
            .mockResolvedValueOnce([[row]])
            .mockResolvedValueOnce([[]]) // dep check: no deps
            .mockResolvedValueOnce([[]]) // UPDATE eligible
            // promoteUnblocked: tq-downstream is blocked, and its only dep is now being retried
            .mockResolvedValueOnce([[{ task_id: 'tq-downstream' }]])
            .mockResolvedValueOnce([[{ status: 'eligible' }]]) // all deps are eligible (retried task)
            .mockResolvedValueOnce([[]]) // UPDATE pending for tq-downstream
            .mockResolvedValueOnce([[]]); // attachDeps
        const task = await retryTask('tq-rtr00004', 'planner-1');
        expect(task.status).toBe('eligible');
        const pendingUpdates = mockExecute.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes("status = 'pending'"));
        expect(pendingUpdates.length).toBeGreaterThan(0);
    });
    it('throws when task not found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // SELECT returns no rows
        await expect(retryTask('tq-notfound', 'planner-1')).rejects.toThrow(/Task not found/);
    });
    it('throws when task is not failed or blocked', async () => {
        const row = makeTaskRow({ id: 'tq-rtr00005', status: 'eligible' });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(retryTask('tq-rtr00005', 'planner-1')).rejects.toThrow(/cannot be retried/);
    });
    it('throws when task is completed (regression: completed tasks must not be silently re-queued)', async () => {
        const row = makeTaskRow({
            id: 'tq-rtr00006',
            status: 'completed',
            result_payload: { answer: 42 },
            completed_at: new Date(),
        });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(retryTask('tq-rtr00006', 'planner-1')).rejects.toThrow(/cannot be retried/);
    });
    it('throws when task is in_progress (cannot re-queue a running task)', async () => {
        const row = makeTaskRow({
            id: 'tq-rtr00007',
            status: 'in_progress',
            claimed_by: 'some-agent',
        });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(retryTask('tq-rtr00007', 'planner-1')).rejects.toThrow(/cannot be retried/);
    });
    it('throws when task is pending (awaiting deps, cannot retry)', async () => {
        const row = makeTaskRow({ id: 'tq-rtr00008', status: 'pending' });
        mockExecute.mockResolvedValueOnce([[row]]);
        await expect(retryTask('tq-rtr00008', 'planner-1')).rejects.toThrow(/cannot be retried/);
    });
});
// ---------------------------------------------------------------------------
// reap
// ---------------------------------------------------------------------------
describe('reap', () => {
    it('lists stale tasks without releasing (doRelease=false)', async () => {
        const staleRow = makeTaskRow({
            id: 'tq-reap0001',
            status: 'in_progress',
            claimed_by: 'zombie-agent',
            claimed_at: new Date('2000-01-01T00:00:00.000Z'),
        });
        mockExecute
            .mockResolvedValueOnce([[staleRow]]) // SELECT stale tasks
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await reap(60_000, false);
        expect(result.stale).toHaveLength(1);
        expect(result.stale[0].id).toBe('tq-reap0001');
        expect(result.released).toHaveLength(0);
        // Should NOT have called UPDATE
        const updateCalls = mockExecute.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('UPDATE tasks'));
        expect(updateCalls.length).toBe(0);
    });
    it('releases stale tasks back to eligible when doRelease=true', async () => {
        const staleRow = makeTaskRow({
            id: 'tq-reap0002',
            status: 'in_progress',
            claimed_by: 'zombie-agent',
            claimed_at: new Date('2000-01-01T00:00:00.000Z'),
        });
        mockExecute
            .mockResolvedValueOnce([[staleRow]]) // SELECT stale tasks FOR UPDATE
            .mockResolvedValueOnce([[]]) // UPDATE tasks SET status='eligible'
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await reap(60_000, true);
        expect(result.stale).toHaveLength(1);
        expect(result.released).toHaveLength(1);
        expect(result.released[0].status).toBe('eligible');
        expect(result.released[0].claimed_by).toBeNull();
    });
    it('returns empty result when no stale tasks found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // No stale tasks
        const result = await reap(60_000, false);
        expect(result.stale).toHaveLength(0);
        expect(result.released).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// releaseTimedOut
// ---------------------------------------------------------------------------
describe('releaseTimedOut', () => {
    it('returns empty result when no timed-out tasks found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // No timed-out tasks
        const result = await releaseTimedOut();
        expect(result.timed_out).toHaveLength(0);
        expect(result.released).toHaveLength(0);
        expect(result.failed).toHaveLength(0);
    });
    it('releases timed-out task back to eligible when attempts remain', async () => {
        const row = makeTaskRow({
            id: 'tq-rto00001',
            status: 'in_progress',
            claimed_by: 'agent-1',
            max_attempts: 3,
            attempt_count: 0,
            timeout_seconds: 60,
            claimed_at: new Date('2000-01-01T00:00:00.000Z'),
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT timed-out tasks
            .mockResolvedValueOnce([[]]) // UPDATE SET status='eligible', attempt_count=1
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await releaseTimedOut();
        expect(result.timed_out).toHaveLength(1);
        expect(result.released).toHaveLength(1);
        expect(result.failed).toHaveLength(0);
        expect(result.released[0].status).toBe('eligible');
        expect(result.released[0].attempt_count).toBe(1);
        const payload = result.released[0].result_payload;
        expect(payload.error).toBe('timeout');
        expect(payload.retrying).toBe(true);
    });
    it('fails a timed-out task when max_attempts exhausted and cascades blocked', async () => {
        const row = makeTaskRow({
            id: 'tq-rto00002',
            status: 'in_progress',
            claimed_by: 'agent-1',
            max_attempts: 1,
            attempt_count: 0,
            timeout_seconds: 60,
            claimed_at: new Date('2000-01-01T00:00:00.000Z'),
        });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT timed-out tasks
            .mockResolvedValueOnce([[]]) // UPDATE SET status='failed'
            // cascadeBlocked: no dependents
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await releaseTimedOut();
        expect(result.timed_out).toHaveLength(1);
        expect(result.released).toHaveLength(0);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].status).toBe('failed');
        const payload = result.failed[0].result_payload;
        expect(payload.error).toBe('timeout');
    });
    it('handles mixed timed-out tasks (some retry, some fail)', async () => {
        const retryRow = makeTaskRow({
            id: 'tq-rto00003',
            status: 'in_progress',
            claimed_by: 'agent-1',
            max_attempts: 3,
            attempt_count: 0,
            timeout_seconds: 60,
            claimed_at: new Date('2000-01-01T00:00:00.000Z'),
        });
        const failRow = makeTaskRow({
            id: 'tq-rto00004',
            status: 'in_progress',
            claimed_by: 'agent-2',
            max_attempts: 1,
            attempt_count: 0,
            timeout_seconds: 60,
            claimed_at: new Date('2000-01-01T00:00:00.000Z'),
        });
        mockExecute
            .mockResolvedValueOnce([[retryRow, failRow]]) // SELECT timed-out tasks
            .mockResolvedValueOnce([[]]) // UPDATE retryRow → eligible
            .mockResolvedValueOnce([[]]) // UPDATE failRow → failed
            // cascadeBlocked for failRow: no dependents
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await releaseTimedOut();
        expect(result.timed_out).toHaveLength(2);
        expect(result.released).toHaveLength(1);
        expect(result.failed).toHaveLength(1);
    });
});
// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------
describe('compact', () => {
    it('compacts a completed task: writes summary, nulls result_payload', async () => {
        const row = makeTaskRow({ id: 'tq-cpt00001', status: 'completed' });
        mockExecute
            .mockResolvedValueOnce([[row]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([[]]); // UPDATE result_summary, result_payload=NULL
        const result = await compact('tq-cpt00001', { summary: 'done' }, 'planner-1');
        expect(result.compacted).toContain('tq-cpt00001');
        expect(result.skipped).toHaveLength(0);
    });
    it('throws when task is not completed (non-subtree mode)', async () => {
        const row = makeTaskRow({ id: 'tq-cpt00002', status: 'in_progress' });
        mockExecute.mockResolvedValueOnce([[row]]); // SELECT FOR UPDATE
        await expect(compact('tq-cpt00002', { summary: 'oops' }, 'planner-1')).rejects.toThrow(/not completed/);
    });
    it('subtree mode: compacts completed descendants, skips incomplete ones', async () => {
        const completedChild = makeTaskRow({ id: 'tq-cpt00003.child01', status: 'completed', parent_id: 'tq-cpt00003' });
        const pendingChild = makeTaskRow({ id: 'tq-cpt00003.child02', status: 'pending', parent_id: 'tq-cpt00003' });
        const rootRow = makeTaskRow({ id: 'tq-cpt00003', status: 'completed' });
        mockExecute
            // CTE for subtree descendants
            .mockResolvedValueOnce([[{ id: 'tq-cpt00003.child01' }, { id: 'tq-cpt00003.child02' }]])
            // SELECT all rows FOR UPDATE
            .mockResolvedValueOnce([[rootRow, completedChild, pendingChild]])
            // UPDATE for root (completed)
            .mockResolvedValueOnce([[]])
            // UPDATE for completedChild (completed)
            .mockResolvedValueOnce([[]]);
        // pendingChild is skipped (not completed)
        const result = await compact('tq-cpt00003', { summary: 'batch done' }, 'planner-1', true);
        expect(result.compacted).toContain('tq-cpt00003');
        expect(result.compacted).toContain('tq-cpt00003.child01');
        expect(result.skipped).toContain('tq-cpt00003.child02');
    });
    it('throws when task not found', async () => {
        // SELECT FOR UPDATE returns empty (non-subtree: no descriptor call first)
        mockExecute.mockResolvedValueOnce([[]]); // SELECT FOR UPDATE — no root row
        await expect(compact('tq-notfound', { summary: 'x' }, 'planner-1')).rejects.toThrow(/Task not found/);
    });
});
// ---------------------------------------------------------------------------
// subtree
// ---------------------------------------------------------------------------
describe('subtree', () => {
    it('returns tasks and status rollup for a parent with children', async () => {
        const child1 = makeTaskRow({ id: 'tq-sub00001.c1', status: 'completed', parent_id: 'tq-sub00001' });
        const child2 = makeTaskRow({ id: 'tq-sub00001.c2', status: 'eligible', parent_id: 'tq-sub00001' });
        mockExecute
            .mockResolvedValueOnce([[makeTaskRow({ id: 'tq-sub00001' })]]) // SELECT parent
            .mockResolvedValueOnce([[child1, child2]]) // CTE descendants
            .mockResolvedValueOnce([[]]); // attachDeps
        const result = await subtree('tq-sub00001');
        expect(result.tasks).toHaveLength(2);
        expect(result.rollup.completed).toBe(1);
        expect(result.rollup.eligible).toBe(1);
        expect(result.rollup.total).toBe(2);
    });
    it('returns empty task list and zero rollup when parent has no children', async () => {
        mockExecute
            .mockResolvedValueOnce([[makeTaskRow({ id: 'tq-sub00002' })]]) // SELECT parent
            .mockResolvedValueOnce([[]]) // CTE: no descendants
        ;
        const result = await subtree('tq-sub00002');
        expect(result.tasks).toHaveLength(0);
        expect(result.rollup.total).toBe(0);
    });
    it('throws when parent task not found', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // SELECT parent: not found
        await expect(subtree('tq-notfound')).rejects.toThrow(/Task not found/);
    });
});
// ---------------------------------------------------------------------------
// ready
// ---------------------------------------------------------------------------
describe('ready', () => {
    it('returns all eligible tasks ordered by priority desc', async () => {
        const rows = [
            makeTaskRow({ id: 'tq-rdy00001', status: 'eligible', priority: 10 }),
            makeTaskRow({ id: 'tq-rdy00002', status: 'eligible', priority: 5 }),
        ];
        mockExecute
            .mockResolvedValueOnce([rows]) // SELECT eligible tasks
            .mockResolvedValueOnce([[]]); // attachDeps
        const tasks = await ready();
        expect(tasks).toHaveLength(2);
        expect(tasks[0].priority).toBe(10);
        expect(tasks[1].priority).toBe(5);
    });
    it('returns empty array when no eligible tasks exist', async () => {
        mockExecute.mockResolvedValueOnce([[]]); // No eligible tasks — attachDeps short-circuits
        const tasks = await ready();
        expect(tasks).toHaveLength(0);
    });
});
//# sourceMappingURL=tasks.test.js.map