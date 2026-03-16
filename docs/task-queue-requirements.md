# Task Queue — Requirements

## Overview

A persistent task queue that drives a fleet of AI agents. Tasks can depend on other tasks, are routed to agents by tag matching, and are safe for concurrent access by multiple agents running simultaneously. Both human operators and agents themselves can enqueue work.

---

## Core concepts

### Task

The fundamental unit of work. A task has:

- **ID** — short hash derived from content at creation time (e.g. `tq-a1b2`); collision-resistant, no central counter required, safe for concurrent agent creation
- **Description** — natural-language description of the work to be done
- **Payload** — structured data the agent needs to execute the task (format TBD per task type)
- **Status** — lifecycle state (see below)
- **Tags** — set of strings that control which agents may pick up the task
- **Parent** — optional task ID; establishes a hierarchical epic/subtask relationship
- **Relationships** — typed edges to other tasks (see below)
- **Created by** — agent ID or `"human"` / operator identifier
- **Claimed by** — agent ID, set atomically when an agent takes the task
- **Timestamps** — created, eligible (dependencies met), claimed, completed/failed

### Task status lifecycle

```
pending ──(deps met)──► eligible ──(claimed)──► in_progress ──(success)──► completed
                                                      │
                                                      └──(failure)──► failed
                                                      └──(timeout/release)──► eligible
```

- `pending` — created but one or more dependencies are not yet complete
- `eligible` — ready to be claimed; all dependencies satisfied
- `in_progress` — claimed by an agent; work is underway
- `completed` — finished successfully; downstream dependents may now become eligible
- `failed` — terminal failure; does not unblock dependents (see failure handling)

### Task IDs

Task IDs are short hashes (e.g. `tq-a1b2`) derived from a combination of content and creation timestamp. Properties:

- Short enough to reference in agent output and conversation
- No central sequence or counter — any agent can generate one independently
- Collision-resistant at the scale of thousands of tasks
- Hierarchical tasks extend the parent ID with a dot-separated suffix (e.g. `tq-a1b2.1`, `tq-a1b2.1.3`) so subtree membership is visible in the ID itself

### Inter-task relationships

Tasks have two distinct mechanisms for relating to other tasks:

**Dependencies** (blocking) — a task with unmet dependencies is not claimable. These are the edges of the execution DAG.

**Typed relationships** (non-blocking) — informational edges that do not affect scheduling. Relationship types:

| Type | Meaning |
|------|---------|
| `relates_to` | General association |
| `duplicates` | This task covers the same work as another |
| `supersedes` | This task replaces another (the other should be cancelled) |
| `replies_to` | This task is a response to or follow-up from another |
| `spawned_from` | This task was created as a side-effect of executing another |

Typed relationships are queryable and visible in the task graph, but do not gate execution.

### Hierarchy (epics and subtasks)

A task may declare a **parent** task ID, establishing a tree structure. The parent does not need to be in a particular state for children to be created or claimed. Hierarchy supports:

- Progress rollup — a parent task's completion percentage is derived from its subtree
- Scoped queries — "show me everything under epic `tq-a1b2`"
- Scoped agent assignment — tags can be inherited or overridden down the tree
- A parent task may itself be a unit of work, or may be a pure container (an epic with no payload of its own)

### Tags and agent capabilities

Tags are free-form strings attached to a task (e.g. `code-review`, `python`, `web-search`, `gpu`). Each agent declares the set of tags it can handle. A task is only claimable by an agent whose capability set is a **superset** of the task's required tags. An empty tag set means any agent can claim it.

This allows:
- Routing by skill (`python`, `bash`, `browser`)
- Routing by trust level or environment (`sandboxed`, `privileged`)
- Routing by resource availability (`gpu`, `high-memory`)
- Dedicated agent pools (`ingestion-agent`, `review-agent`)

---

## Functional requirements

### Task management

- **FR-1** A task must support zero or more dependency task IDs. A task with unsatisfied dependencies is not claimable.
- **FR-2** Dependencies form a directed acyclic graph (DAG). Circular dependencies must be rejected at creation time.
- **FR-3** When a task transitions to `completed`, the queue must re-evaluate all tasks that listed it as a dependency and promote any newly eligible tasks to `eligible`.
- **FR-4** Tasks may specify a **timeout** duration. If an in-progress task is not completed or heartbeated within this window, it is automatically released back to `eligible` and the claim is cleared.
- **FR-5** Tasks may carry a **priority** value. Within the eligible set, higher-priority tasks should be offered to agents first.
- **FR-6** Tasks may optionally carry a **result payload** written by the completing agent, which downstream tasks can read from their dependency records.
- **FR-7** A task may declare a **parent** task ID at creation time. The parent must exist. Parent tasks expose a progress rollup (counts and percentage of subtree by status).
- **FR-8** Typed inter-task relationships (`relates_to`, `duplicates`, `supersedes`, `replies_to`, `spawned_from`) may be added at any time by any agent or operator. They do not affect scheduling.

### Claiming and concurrency

- **FR-9** Claiming a task must be atomic — exactly one agent receives a given task even under concurrent polling. This must hold without application-level locking on the client side (i.e. the queue backend enforces it).
- **FR-10** An agent claims a task by providing its agent ID and capability tag set. The queue returns at most one task whose required tags are a subset of the agent's capabilities.
- **FR-11** A claimed task must be heartbeated periodically by the holding agent. Absence of a heartbeat within the timeout window releases the task.
- **FR-12** An agent may explicitly release a task (e.g. on graceful shutdown) without marking it failed, returning it to `eligible`.

### Failure handling

- **FR-13** Tasks must support a **max attempts** count. On failure, if attempts remain, the task returns to `eligible` after a configurable backoff delay. Once attempts are exhausted, the task moves to `failed`.
- **FR-14** A failed task may optionally trigger a configurable **on-failure** task to be enqueued (e.g. a notification or cleanup task).
- **FR-15** Downstream tasks whose dependency failed must be marked `blocked` (a sub-state of pending) and not become eligible unless the failed dependency is explicitly retried and eventually completes.

### Enqueueing

- **FR-16** Any agent may enqueue new tasks at any time, including from within a running task. Agents may enqueue tasks that depend on their own current task ID (fan-out pattern).
- **FR-17** Human operators must be able to enqueue, inspect, cancel, and retry tasks via a CLI or lightweight UI.
- **FR-18** Batch enqueueing (submitting a graph of tasks with dependencies in one operation) must be supported and atomic — either the entire graph is accepted or none of it is.

### Observability

- **FR-19** The queue must expose a view of current status counts by state and tag.
- **FR-20** Each task must maintain a log of status transitions with timestamps and agent IDs.
- **FR-21** It must be possible to query: all tasks in a given state, all tasks with a given tag, all tasks that are blocking a given task, all tasks that a given task is blocking.
- **FR-22** Subtree queries must be supported: given a parent task ID, return all descendants with their statuses and a rollup summary.

### Output format

- **FR-23** Every CLI command must support a `--json` flag that returns machine-readable JSON suitable for agent consumption. Human-readable output is the default; JSON output must be stable and versioned.
- **FR-24** The agent API always returns structured data (JSON/dict). It must never require parsing human-readable text.

---

## Non-functional requirements

- **NFR-1 Durability** — task state must survive process restarts. An embedded or external persistent store is acceptable; in-memory-only is not.
- **NFR-2 Concurrent agents** — must support at least tens of simultaneous agents polling and executing without correctness issues.
- **NFR-3 Latency** — claim operations should complete in under 100 ms under normal load.
- **NFR-4 Simplicity of deployment** — should be runnable without external infrastructure dependencies if possible (e.g. SQLite-backed for single-host deployments), with a path to scale out (e.g. Postgres).

---

## Interfaces

### Agent API (programmatic)

The primary interface for agents. Must be callable from Python (and ideally language-agnostic via HTTP or a simple protocol).

```
# Core operations
enqueue(description, payload, tags, dependencies, parent, priority, max_attempts, timeout) → task_id
relate(task_id, type, target_task_id) → ok
claim(agent_id, agent_tags) → Task | None
heartbeat(task_id, agent_id) → ok
complete(task_id, agent_id, result_payload) → ok
fail(task_id, agent_id, reason) → ok
release(task_id, agent_id) → ok

# Introspection
get(task_id) → Task
list(status?, tags?, parent?, created_by?) → [Task]
subtree(task_id) → [Task]            # all descendants + rollup
ready(agent_tags) → [Task]           # all currently claimable tasks for this agent
get_result(task_id) → result_payload
get_dep_results(task_id) → {dep_id: result_payload}   # all dependency results at once
```

### Human operator interface (CLI)

```
tasks enqueue --description "..." --tag foo --tag bar --depends-on <id> --parent <id>
tasks relate <id> --type supersedes --target <id>
tasks list [--status eligible|in_progress|...] [--tag foo] [--parent <id>] [--json]
tasks show <id> [--json]
tasks subtree <id> [--json]
tasks ready [--tag foo]              # what's claimable right now
tasks cancel <id>
tasks retry <id>
tasks graph <id>                     # show dependency + hierarchy tree
```

---

## Open questions

1. **Tag matching semantics** — strict superset (all required tags must match), or scored/partial matching with fallback?
2. **DAG cycles across batch enqueues** — how to detect cycles when a batch references task IDs that don't exist yet?
3. **Failed dependency propagation depth** — should failure cascade recursively to all transitive dependents, or only direct children?
4. **Result payload schema** — freeform JSON, or typed per task kind?
5. **Multi-host scaling** — is single-host (SQLite) sufficient for the initial use case, or is distributed operation (Postgres + multiple queue workers) a day-one requirement?
6. **Human UI** — is a CLI sufficient, or is a read-only web dashboard needed for observability?
7. **ID hash input** — what content is hashed to produce the task ID? Description + timestamp + creator is a candidate; needs to be deterministic for batch-enqueued graphs where IDs must be known before insertion.
8. **Relationship mutability** — can relationships be removed, or are they append-only? Append-only is simpler and provides a better audit trail.
9. **Parent task completion semantics** — does a parent auto-complete when all children complete, or must it be explicitly completed?
