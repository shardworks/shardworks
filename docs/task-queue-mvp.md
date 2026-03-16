# Task Queue — MVP

Goal: a working task queue that agents can claim work from and report results to, with enough structure (dependencies, hierarchy) to be immediately useful for dogfooding the orchestrator. Single-server, no heartbeat or retry machinery, no branching, no compaction.

---

## What is in scope

### Stack

- **Language**: TypeScript throughout
- **TypeScript**: 5.9+
- **Node.js**: 24.x
- **Storage**: Dolt (MySQL-compatible, running as a compose service)
- **HTTP server**: Fastify
- **DB client**: `mysql2`
- **Packages**: monorepo with `packages/shared-types` and `packages/queue-server`

### Task model

| Field | Notes |
|-------|-------|
| `id` | Short hash, e.g. `tq-a1b2`. Subtasks use dot-suffix: `tq-a1b2.c3d4`. |
| `description` | Natural-language description |
| `payload` | Freeform JSON; input data for the agent |
| `status` | `pending` / `eligible` / `in_progress` / `completed` / `failed` |
| `parent_id` | Optional; establishes epic/subtask hierarchy |
| `priority` | Integer; higher = offered first within the eligible set |
| `result_payload` | Freeform JSON written by the completing agent |
| `created_by` | Agent ID or `"human"` |
| `claimed_by` | Agent ID; set atomically on claim |
| `created_at` | Timestamp |
| `eligible_at` | Timestamp when all dependencies were last satisfied |
| `claimed_at` | Timestamp of most recent claim |
| `completed_at` | Timestamp of completion or failure |

Fields deferred to post-MVP: `max_attempts`, `attempt_count`, `timeout_seconds`, `result_summary`.

### Status lifecycle

```
pending ──(deps met)──► eligible ──(claimed)──► in_progress ──(success)──► completed
                                                      │
                                                      └──(fail)──► failed
```

`blocked` and `cancelled` are post-MVP.

### Task IDs

- Derived from a hash of `(description, created_by, timestamp)`
- Short 4-character hex suffix after the `tq-` prefix
- Subtask IDs extend parent with a dot and a new hash: `tq-a1b2.c3d4`
- No central counter; safe for concurrent creation

### Dependencies

- Declared at creation time as a list of existing task IDs
- Form a DAG; cycles rejected at creation time
- A task with all dependencies `completed` is `eligible`; otherwise `pending`
- When a task completes, all direct dependents that are now fully unblocked are promoted to `eligible`
- A task with a `failed` dependency stays `pending` for now (blocked/cascade is post-MVP)

### Hierarchy

- A task may declare a `parent_id` at creation; parent must exist
- Subtree query returns all descendants with a status rollup
- No auto-complete semantics for parents in MVP; parents are completed explicitly

### Claim

- Returns the highest-priority eligible task
- Wrapped in a database transaction; safe even if the server has multiple concurrent connections
- If no eligible task exists, returns `null`

### Operations

```
// Enqueue
POST /tasks                          enqueue a single task
POST /tasks/batch                    enqueue a graph of tasks atomically

// Agent workflow
POST /tasks/claim                    claim next eligible task for agent
POST /tasks/:id/complete             mark complete, write result_payload
POST /tasks/:id/fail                 mark failed with reason

// Queries
GET  /tasks/:id                      get a single task
GET  /tasks                          list tasks (filter by status, parent)
GET  /tasks/:id/subtree              all descendants + status rollup
GET  /tasks/ready                    all currently claimable tasks
GET  /tasks/:id/dep-results          result_payloads of all dependencies
```

All responses are JSON. All errors return a structured `{ error, message }` body.

### Audit

Every mutating operation (`enqueue`, `claim`, `complete`, `fail`) is wrapped in a Dolt commit. Commit message format: `[op] task <id> by <actor>`. This gives a free history of all state changes via `SELECT * FROM dolt_log` without any additional application code. Full audit query API (revert, diff endpoints) is post-MVP.

---

## What is explicitly out of scope (post-MVP)

| Feature | Reason deferred |
|---------|----------------|
| Heartbeat / timeout / auto-release | Requires background worker; adds operational complexity |
| Retry / max_attempts / backoff | Related to heartbeat; deferred together |
| `blocked` status + cascade failure | Adds state machine complexity; `pending` is safe enough for now |
| `cancel` / `release` operations | Not needed for basic dogfooding loop |
| Typed relationships (`relates_to`, etc.) | Pure metadata; not load-bearing for MVP |
| `result_summary` / compaction | Context window management is post-MVP |
| Branching | Powerful but not needed for single-workstream dogfood |
| Audit query API (revert, diff, history endpoint) | Dolt history is still being written; query layer deferred |
| CLI tool | Use HTTP directly or curl for MVP |
| Status counts / dashboard | Use `GET /tasks?status=...` for now |

---

## Tasks

Each task is ordered so that its dependencies are completed first. Tasks at the same level can be worked in parallel.

---

### T01 — Monorepo project structure

Set up the TypeScript monorepo with two packages: `shared-types` and `queue-server`. Configure `tsconfig`, `eslint`, `vitest`, and a root `package.json` with workspace scripts.

**Depends on:** nothing

---

### T02 — Shared type definitions

Define all TypeScript types in `shared-types`:
- `TaskStatus` enum (`pending`, `eligible`, `in_progress`, `completed`, `failed`)
- `Task` interface (all MVP fields)
- Request types: `EnqueueInput`, `BatchEnqueueInput`, `ClaimInput`, `CompleteInput`, `FailInput`
- Response types: `ClaimResult`, `SubtreeResult`, `StatusRollup`, `DepResults`
- Error type: `ApiError`

**Depends on:** T01

---

### T03 — Dolt connection and database schema

Establish a `mysql2` connection pool to `DOLT_HOST:DOLT_PORT`. Define and apply the schema:

```sql
CREATE TABLE tasks (
  id           VARCHAR(64)  PRIMARY KEY,
  description  TEXT         NOT NULL,
  payload      JSON,
  status       VARCHAR(32)  NOT NULL DEFAULT 'pending',
  parent_id    VARCHAR(64)  REFERENCES tasks(id),
  priority     INT          NOT NULL DEFAULT 0,
  result_payload JSON,
  created_by   VARCHAR(255) NOT NULL,
  claimed_by   VARCHAR(255),
  created_at   DATETIME(3)  NOT NULL,
  eligible_at  DATETIME(3),
  claimed_at   DATETIME(3),
  completed_at DATETIME(3)
);

CREATE TABLE task_dependencies (
  task_id  VARCHAR(64) NOT NULL REFERENCES tasks(id),
  dep_id   VARCHAR(64) NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, dep_id)
);
```

Include an `init-schema.ts` script that creates the tables if they don't exist (idempotent).

**Depends on:** T02

---

### T04 — Hash ID generation

Utility function `generateId(description, createdBy, timestamp): string` that produces a short, stable ID in the form `tq-XXXX` (4 hex chars). For subtasks, `generateChildId(parentId, description, createdBy, timestamp): string` that prefixes with the parent and a dot.

The hash input must be deterministic so that batch-enqueued tasks can reference each other's IDs before insertion.

**Depends on:** T01

---

### T05 — Single task enqueue + get + list

Implement:
- `enqueue(input: EnqueueInput): Promise<Task>` — insert a task row, insert dependency rows, set initial status (`eligible` if no dependencies, `pending` otherwise)
- `getTask(id: string): Promise<Task>`
- `listTasks(filters): Promise<Task[]>` — filter by `status`, `parent_id`, `created_by`

**Depends on:** T02, T03, T04

---

### T06 — Dependency DAG validation

On enqueue, validate that adding the declared dependencies does not create a cycle. Use a depth-first traversal of the existing dependency graph. Reject with a descriptive error if a cycle is detected.

Also implement `getDepResults(taskId): Promise<DepResults>` — returns `{ [depId]: result_payload }` for all direct dependencies of a task.

**Depends on:** T03, T05

---

### T07 — Eligibility promotion

After a task transitions to `completed`, query all tasks that list it as a dependency. For each, check whether all its dependencies are now `completed`. If so, set status to `eligible` and record `eligible_at`. This runs within the same transaction as the `complete` operation.

**Depends on:** T05, T06

---

### T08 — Batch enqueue

`batchEnqueue(inputs: BatchEnqueueInput): Promise<Task[]>` — accepts an array of task inputs with intra-batch dependency references (using client-assigned IDs). Validates the entire graph for cycles, then inserts all tasks and dependency rows in a single transaction. Either all succeed or none do.

**Depends on:** T05, T06

---

### T09 — Claim

`claim(agentId: string): Promise<Task | null>` — within a single transaction:
1. Select the highest-priority `eligible` task, with `SELECT ... FOR UPDATE`
2. Set status to `in_progress`, set `claimed_by` and `claimed_at`
3. Return the task, or `null` if none matched

**Depends on:** T05, T07

---

### T10 — Complete

`complete(taskId: string, agentId: string, resultPayload: unknown): Promise<Task>` — within a transaction:
1. Validate task is `in_progress` and `claimed_by === agentId`
2. Set status to `completed`, write `result_payload`, set `completed_at`
3. Run eligibility promotion (T07) for all dependents

**Depends on:** T07, T09

---

### T11 — Fail

`fail(taskId: string, agentId: string, reason: string): Promise<Task>` — validate task is `in_progress` and `claimed_by === agentId`, then set status to `failed` and write the reason to `result_payload` as `{ error: reason }`.

**Depends on:** T09

---

### T12 — Subtree and ready queries

- `subtree(parentId: string): Promise<SubtreeResult>` — recursively fetch all descendants using a recursive CTE, return them with a `StatusRollup` (counts by status)
- `ready(): Promise<Task[]>` — return all `eligible` tasks, ordered by priority descending

**Depends on:** T05, T06

---

### T13 — Dolt commit wrapping

Wrap each mutating database operation (`enqueue`, `batchEnqueue`, `claim`, `complete`, `fail`) in a Dolt commit using `CALL dolt_commit('-m', '<message>')` after the transaction commits. Commit message format: `[<op>] <taskId> by <actor>`.

This can be implemented as a thin wrapper around the existing operation functions — no changes to their signatures.

**Depends on:** T05, T09, T10, T11

---

### T14 — Fastify HTTP server and routes

Wire all operations into a Fastify server. Define routes for all MVP endpoints, with request validation (JSON Schema or Zod) and structured error responses. Server reads `DOLT_HOST`, `DOLT_PORT`, and `PORT` from environment.

```
POST /tasks
POST /tasks/batch
POST /tasks/claim
POST /tasks/:id/complete
POST /tasks/:id/fail
GET  /tasks/:id
GET  /tasks
GET  /tasks/:id/subtree
GET  /tasks/ready
GET  /tasks/:id/dep-results
```

**Depends on:** T05, T06, T07, T08, T09, T10, T11, T12

---

## Dependency graph

```
T01
 ├── T02
 │    └── T03 ──────────────────────────────────┐
 │         ├── T05 ──── T06 ──── T07 ──── T08   │
 │         │             │       │               │
 │         │             └── T12 │               │
 │         │                     │               │
 └── T04 ──┘                     ├── T09 ─── T10 ─── T13
                                 │        └─ T11 ─┘
                                 └────────────────────── T14
```

Linear critical path: **T01 → T02 → T03 → T05 → T06 → T07 → T09 → T10 → T14**
