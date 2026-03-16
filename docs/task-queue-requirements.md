# Task Queue — Requirements

## Overview

A persistent, version-controlled task queue that drives a fleet of AI agents. Built on [Dolt](https://github.com/dolthub/dolt) — a MySQL-compatible SQL database with native Git-style branching, merging, and commit history. Every state change is a committed, revertable, auditable event. Agents and human operators interact with the same data model through complementary interfaces.

---

## Backend: Dolt

Dolt is the storage layer. Its properties shape the entire design:

- **Version-controlled tables** — every write is (or can be wrapped in) a named commit. The full history of every task is queryable via system tables (`dolt_log`, `dolt_diff_*`).
- **MySQL-compatible** — the queue server speaks standard SQL; no custom storage engine needed.
- **Native branching** — branch, merge, and diff are first-class database operations, not application-layer constructs.
- **Cell-level merge** — concurrent writes to different rows merge cleanly in the common case, enabling multiple agents to update task state without central coordination beyond atomic claim.
- **Remote sync** — Dolt supports push/pull to remote repositories, enabling distributed or replicated deployments without a separate replication layer.

The queue server wraps Dolt and exposes the task queue API. It is responsible for enforcing business logic (atomic claim, dependency promotion, heartbeat timeouts) on top of Dolt's storage primitives.

---

## Core concepts

### Task

The fundamental unit of work. A task has:

| Field | Description |
|-------|-------------|
| `id` | Short content hash (e.g. `tq-a1b2`). See [Task IDs](#task-ids). |
| `description` | Natural-language description of the work |
| `payload` | Structured JSON data the agent needs to execute the task |
| `status` | Lifecycle state (see [Status lifecycle](#task-status-lifecycle)) |
| `tags` | Set of strings controlling which agents may claim the task |
| `parent_id` | Optional parent task ID; establishes epic/subtask hierarchy |
| `priority` | Integer; higher values are offered to agents first within the eligible set |
| `max_attempts` | How many times this task may be attempted before moving to `failed` |
| `attempt_count` | How many attempts have been made so far |
| `timeout_seconds` | Heartbeat window; task is released if not heartbeated within this period |
| `result_payload` | Full structured output written by the completing agent |
| `result_summary` | Compact summary of `result_payload`; written by agent or produced by compaction |
| `created_by` | Agent ID or operator identifier |
| `claimed_by` | Agent ID; set atomically on claim |
| `created_at` | Timestamp |
| `eligible_at` | Timestamp when all dependencies were last satisfied |
| `claimed_at` | Timestamp of most recent claim |
| `completed_at` | Timestamp of completion or terminal failure |

### Task IDs

Task IDs are short hashes (e.g. `tq-a1b2`) derived from a hash of the description, creator ID, and creation timestamp. Properties:

- Short enough to reference in agent output and natural language
- No central counter — any agent can generate one independently without coordination
- Collision-resistant at the scale of thousands to tens of thousands of tasks
- Subtasks extend the parent ID with a dot-separated child hash (e.g. `tq-a1b2.c3d4`, `tq-a1b2.c3d4.e5f6`), making subtree membership visible in the ID itself while remaining safe for concurrent child creation by multiple agents

### Task status lifecycle

```
pending ──(deps met)──► eligible ──(claimed)──► in_progress ──(success)──► completed
   ▲                                                  │
   │                                                  ├──(failure, attempts remain)──► eligible (after backoff)
   │                                                  ├──(failure, no attempts left)──► failed
   │                                                  └──(timeout / explicit release)──► eligible
   │
   └── blocked  (a dependency reached `failed` terminally)
```

| Status | Meaning |
|--------|---------|
| `pending` | Created; one or more dependencies not yet complete |
| `eligible` | All dependencies satisfied; ready to be claimed |
| `in_progress` | Claimed by an agent; work underway |
| `completed` | Finished successfully |
| `failed` | Terminal failure; exhausted all attempts |
| `blocked` | A dependency failed terminally; will not become eligible without operator intervention |
| `cancelled` | Explicitly cancelled by an operator or agent |

### Inter-task relationships

Tasks relate to each other through two distinct mechanisms:

**Dependencies** (scheduling edges) — a task cannot be claimed until all its dependencies reach `completed`. These edges form the execution DAG and are declared at creation time.

**Typed relationships** (informational edges) — non-blocking annotations that enrich the task graph. May be added at any time by any agent or operator.

| Type | Meaning |
|------|---------|
| `relates_to` | General association |
| `duplicates` | This task covers the same work as another |
| `supersedes` | This task replaces another (the other should be cancelled) |
| `replies_to` | This task is a response to or follow-up on another |
| `spawned_from` | This task was created as a side-effect of executing another |

### Hierarchy (epics and subtasks)

A task may declare a `parent_id`, establishing a tree. The parent need not be in any particular state for children to be created or claimed. The dot-suffix ID scheme makes hierarchy visible without a separate query.

- **Progress rollup** — a parent's status summary is derived from its subtree (e.g. "12 completed, 3 in_progress, 5 pending")
- **Scoped queries** — return all tasks under a given parent
- **Container tasks** — a parent may have no payload of its own and exist purely as an organizational node (an epic)
- **Completion semantics** — configurable per-task: auto-complete when all children complete, or require explicit completion (see [Open questions](#open-questions))

### Tags and agent capabilities

Tags are free-form strings on a task. Each agent declares the capability tags it handles. A task is only claimable by an agent whose capability set is a **superset** of the task's required tags. An empty tag set means any agent may claim it.

Examples:
- Skill routing: `python`, `bash`, `browser`, `code-review`
- Trust/environment routing: `sandboxed`, `privileged`, `network-access`
- Resource routing: `gpu`, `high-memory`
- Pool routing: `ingestion-agent`, `reviewer`

---

## Functional requirements

### Task management

- **FR-1** A task must support zero or more dependency task IDs. A task with unsatisfied dependencies is not claimable.
- **FR-2** Dependencies form a DAG. Circular dependencies must be rejected at creation time.
- **FR-3** When a task transitions to `completed`, the queue must atomically promote all newly-unblocked dependents to `eligible`.
- **FR-4** Tasks may specify a timeout. If an in-progress task is not completed or heartbeated within this window, it is released back to `eligible` and the claim is cleared.
- **FR-5** Tasks carry a priority value. Within the eligible set, higher-priority tasks are offered to agents first.
- **FR-6** A task may declare a parent at creation time. The parent must exist. Parent tasks expose a live progress rollup over their subtree.
- **FR-7** Typed inter-task relationships may be added at any time. They do not affect scheduling.

### Claiming and concurrency

- **FR-8** Claiming a task must be atomic — exactly one agent receives a given task under concurrent polling, enforced by the backend without client-side locking.
- **FR-9** An agent claims a task by providing its agent ID and capability tags. The queue returns at most one eligible task whose required tags are a subset of the agent's capabilities.
- **FR-10** A claimed task must be heartbeated periodically. Absence of a heartbeat releases the task back to `eligible`.
- **FR-11** An agent may explicitly release a task without marking it failed, returning it to `eligible`.

### Failure handling

- **FR-12** On failure, if attempts remain, the task returns to `eligible` after a configurable backoff. Once attempts are exhausted, the task transitions to `failed`.
- **FR-13** A failed task may declare an on-failure task to enqueue (e.g. alerting, cleanup).
- **FR-14** When a dependency transitions to `failed` terminally, all direct and transitive dependents are marked `blocked`. They become eligible again only if the failed dependency is explicitly retried and eventually completes.

### Enqueueing

- **FR-15** Any agent may enqueue tasks at any time, including depending on its own current task ID (fan-out).
- **FR-16** Human operators may enqueue, inspect, cancel, and retry tasks via CLI.
- **FR-17** Batch enqueueing of a task graph is supported and atomic — the whole graph is accepted or none of it is.

### Observability

- **FR-18** The queue exposes status counts by state and tag.
- **FR-19** A `ready` query returns all currently claimable tasks for a given agent capability set.
- **FR-20** Subtree queries return all descendants of a parent with a rollup summary.
- **FR-21** Relationship queries: what blocks a task, what does a task block, what is related to a task.

### Output format

- **FR-22** Every CLI command supports a `--json` flag returning stable, versioned, machine-readable JSON.
- **FR-23** The agent API always returns structured data. It never requires parsing human-readable text.

---

## Audit trail

Every mutation to task state is recorded as a Dolt commit with a structured commit message containing the operation type, actor (agent or operator), and relevant task IDs. This is not a separate event log — it is the database's native history.

- **FR-24** Every task state transition (create, claim, complete, fail, release, cancel, relate, etc.) must be wrapped in a named Dolt commit.
- **FR-25** The full history of any task must be queryable: who changed it, when, from what state, to what state.
- **FR-26** The queue must expose a `revert` operation that restores the database to the state of any prior commit. This enables recovery from erroneous bulk state changes (e.g. a rogue agent completing tasks incorrectly).
- **FR-27** It must be possible to query a diff between two points in time: "what changed between commit A and commit B?"
- **FR-28** Agent sessions should be bracketed by commits (start-of-session and end-of-session commits) so the effects of any single agent's work are isolatable and revertable as a unit.

---

## Branching

Dolt branches are used to isolate speculative, experimental, or reviewed-before-merge workstreams from the main task queue.

### Branch lifecycle

```
main ──────────────────────────────────────────────► main
       │                               │
       └── feature-branch ─────────── merge (or abandon)
```

- **FR-29** Any agent or operator may create a branch from any commit on any existing branch.
- **FR-30** An agent may be assigned to work exclusively on a named branch, keeping its task mutations isolated from `main`.
- **FR-31** Branches may be merged into their parent branch. Dolt's cell-level merge handles non-conflicting changes automatically. Conflicts surface as merge conflicts requiring operator resolution.
- **FR-32** Branches may be abandoned (deleted) with no effect on other branches.
- **FR-33** The `claim` operation must accept an optional branch parameter. An agent polling on a branch only sees and claims tasks visible on that branch.
- **FR-34** The `ready` query must be branch-scoped.

### Use cases (informational)

- **Competing approaches** — spawn two branches, assign agent teams to each, merge the winner.
- **Agent-driven restructuring** — an agent that wants to reprioritize or decompose the task tree works on a branch; a human reviews and merges if the changes look correct.
- **Review gate** — an agent completes a body of work on a branch and opens it for human review before results propagate to `main` and unblock downstream tasks. This is a PR workflow for task state.
- **Safe testing** — a new agent implementation runs against a branch; its mutations cannot corrupt the main workstream.

---

## Compaction

As pipelines grow, result payloads from completed tasks accumulate. Agents loading their dependency results for context may receive thousands of tokens of prior output before doing any work. Compaction addresses this by replacing full result payloads with compact summaries, while preserving the originals in Dolt history.

- **FR-35** Every task has both a `result_payload` (full output) and a `result_summary` (compact version) field. Either or both may be populated.
- **FR-36** When an agent reads dependency results (`get_dep_results`), it receives `result_summary` if present, falling back to `result_payload`. The full payload is available on explicit request.
- **FR-37** A compaction operation may be applied to a completed task or subtree. It replaces `result_payload` with `null` in the live table, writing the summary to `result_summary`. The full payload remains accessible via Dolt history at the commit preceding compaction.
- **FR-38** Compaction may be triggered manually by an operator or agent, or automatically when a subtree fully completes (configurable).
- **FR-39** Compaction is itself an audited operation — the commit message records what was compacted, by whom, and when.

---

## Non-functional requirements

- **NFR-1 Durability** — Dolt is the durable store. The queue server is stateless beyond its connection to Dolt; restarts do not lose data.
- **NFR-2 Concurrent agents** — must support tens of simultaneous agents polling and executing without correctness issues. Atomic claim relies on Dolt's transaction semantics.
- **NFR-3 Latency** — claim operations complete in under 100 ms under normal load.
- **NFR-4 Deployment** — single-node Dolt for initial deployments; Dolt's native remote sync provides a path to replication without application-layer changes.
- **NFR-5 MySQL compatibility** — any MySQL client or ORM can be used to query task state directly, enabling ad-hoc operator queries without going through the queue API.

---

## Interfaces

### Agent API (programmatic)

```
# Task operations
enqueue(description, payload, tags, dependencies, parent, priority, max_attempts, timeout) → task_id
relate(task_id, type, target_task_id) → ok
claim(agent_id, agent_tags, branch?) → Task | None
heartbeat(task_id, agent_id) → ok
complete(task_id, agent_id, result_payload, result_summary?) → ok
fail(task_id, agent_id, reason) → ok
release(task_id, agent_id) → ok
cancel(task_id, agent_id, reason) → ok

# Introspection
get(task_id, branch?) → Task
list(status?, tags?, parent?, created_by?, branch?) → [Task]
subtree(task_id, branch?) → {tasks: [Task], rollup: StatusCounts}
ready(agent_tags, branch?) → [Task]
get_dep_results(task_id) → {dep_id: result_summary | result_payload}
get_result(task_id, full?) → result_summary | result_payload

# Branching
branch_create(name, from_branch?) → ok
branch_merge(source, target) → MergeResult
branch_delete(name) → ok
branch_list() → [Branch]

# Audit
history(task_id) → [CommitRecord]
diff(from_commit, to_commit) → [TaskChange]
revert(to_commit) → ok

# Compaction
compact(task_id_or_subtree_root) → ok
```

### Human operator interface (CLI)

```
tasks enqueue --description "..." --tag foo --depends-on <id> --parent <id> [--json]
tasks relate <id> --type supersedes --target <id>
tasks list [--status eligible|...] [--tag foo] [--parent <id>] [--branch <name>] [--json]
tasks show <id> [--full-result] [--json]
tasks subtree <id> [--json]
tasks ready [--tag foo] [--branch <name>]
tasks cancel <id>
tasks retry <id>
tasks graph <id>                    # dependency + hierarchy tree

tasks branch create <name> [--from <branch>]
tasks branch merge <source> --into <target>
tasks branch delete <name>
tasks branch list [--json]

tasks history <id> [--json]
tasks diff <commit-a> <commit-b> [--json]
tasks revert <commit> [--dry-run]

tasks compact <id> [--subtree]
```

---

## Open questions

1. **Tag matching semantics** — strict superset, or scored/partial matching with fallback?
2. **DAG cycles in batch enqueues** — how to detect cycles when a batch references not-yet-inserted task IDs?
3. **Result payload schema** — freeform JSON, or typed per task kind?
4. **Parent completion semantics** — does a parent auto-complete when all children complete, or must it be explicitly completed? Should this be configurable per-task?
5. **Relationship mutability** — append-only (simpler, better audit trail) or mutable?
6. **Compaction trigger** — manual only, automatic on subtree completion, or both with configuration?
7. **Branch merge conflicts** — if two branches modify the same task's status concurrently, Dolt surfaces a conflict. What is the resolution UX? Operator-only, or can agents resolve?
8. **Commit granularity** — one Dolt commit per task operation, or batch commits (e.g. all operations in a single agent API call)? Finer granularity gives better audit; coarser is faster.
9. **Human UI** — CLI sufficient, or is a read-only web dashboard needed for observability?
10. **ID hash input** — what exactly is hashed? Needs to be deterministic for batch graphs where child IDs must be known before insertion.
