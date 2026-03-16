# Task Queue — Requirements

## Overview

A persistent task queue that drives a fleet of AI agents. Tasks can depend on other tasks, are routed to agents by tag matching, and are safe for concurrent access by multiple agents running simultaneously. Both human operators and agents themselves can enqueue work.

---

## Core concepts

### Task

The fundamental unit of work. A task has:

- **ID** — unique, stable identifier (e.g. UUID or human-readable slug)
- **Description** — natural-language description of the work to be done
- **Payload** — structured data the agent needs to execute the task (format TBD per task type)
- **Status** — lifecycle state (see below)
- **Tags** — set of strings that control which agents may pick up the task
- **Dependencies** — ordered list of task IDs that must reach `completed` before this task becomes eligible
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

### Claiming and concurrency

- **FR-7** Claiming a task must be atomic — exactly one agent receives a given task even under concurrent polling. This must hold without application-level locking on the client side (i.e. the queue backend enforces it).
- **FR-8** An agent claims a task by providing its agent ID and capability tag set. The queue returns at most one task whose required tags are a subset of the agent's capabilities.
- **FR-9** A claimed task must be heartbeated periodically by the holding agent. Absence of a heartbeat within the timeout window releases the task.
- **FR-10** An agent may explicitly release a task (e.g. on graceful shutdown) without marking it failed, returning it to `eligible`.

### Failure handling

- **FR-11** Tasks must support a **max attempts** count. On failure, if attempts remain, the task returns to `eligible` after a configurable backoff delay. Once attempts are exhausted, the task moves to `failed`.
- **FR-12** A failed task may optionally trigger a configurable **on-failure** task to be enqueued (e.g. a notification or cleanup task).
- **FR-13** Downstream tasks whose dependency failed must be marked `blocked` (a sub-state of pending) and not become eligible unless the failed dependency is explicitly retried and eventually completes.

### Enqueueing

- **FR-14** Any agent may enqueue new tasks at any time, including from within a running task. Agents may enqueue tasks that depend on their own current task ID (fan-out pattern).
- **FR-15** Human operators must be able to enqueue, inspect, cancel, and retry tasks via a CLI or lightweight UI.
- **FR-16** Batch enqueueing (submitting a graph of tasks with dependencies in one operation) must be supported and atomic — either the entire graph is accepted or none of it is.

### Observability

- **FR-17** The queue must expose a view of current status counts by state and tag.
- **FR-18** Each task must maintain a log of status transitions with timestamps and agent IDs.
- **FR-19** It must be possible to query: all tasks in a given state, all tasks with a given tag, all tasks that are blocking a given task, all tasks that a given task is blocking.

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
enqueue(description, payload, tags, dependencies, priority, max_attempts, timeout) → task_id
claim(agent_id, agent_tags) → Task | None
heartbeat(task_id, agent_id) → ok
complete(task_id, agent_id, result_payload) → ok
fail(task_id, agent_id, reason) → ok
release(task_id, agent_id) → ok

# Introspection
get(task_id) → Task
list(status?, tags?, created_by?) → [Task]
get_result(task_id) → result_payload
```

### Human operator interface (CLI)

```
tasks enqueue --description "..." --tag foo --tag bar --depends-on <id>
tasks list [--status eligible|in_progress|...] [--tag foo]
tasks show <id>
tasks cancel <id>
tasks retry <id>
tasks graph <id>   # show dependency tree
```

---

## Open questions

1. **Tag matching semantics** — strict superset (all required tags must match), or scored/partial matching with fallback?
2. **DAG cycles across batch enqueues** — how to detect cycles when a batch references task IDs that don't exist yet?
3. **Failed dependency propagation depth** — should failure cascade recursively to all transitive dependents, or only direct children?
4. **Result payload schema** — freeform JSON, or typed per task kind?
5. **Multi-host scaling** — is single-host (SQLite) sufficient for the initial use case, or is distributed operation (Postgres + multiple queue workers) a day-one requirement?
6. **Human UI** — is a CLI sufficient, or is a read-only web dashboard needed for observability?
