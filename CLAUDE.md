# Shardworks

## Task Queue CLI

The `tq` command interacts with the Shardworks task queue backed by Dolt (MySQL-compatible).
All commands print JSON to stdout and exit 0 on success, non-zero on error.

### Read commands

```bash
# Show a single task (full task object)
tq show <id>

# Show result_payload of every direct dependency
tq dep-results <id>

# List tasks with optional filters
tq list [--status draft|pending|eligible|in_progress|completed|failed] [--parent <id>] [--created-by <id>]

# List all currently claimable tasks, highest priority first
tq ready

# Show all descendants of a task with a status rollup
tq subtree <id>
```

### Claim (conductor)

```bash
# Atomically claim the highest-priority eligible task for an agent (eligible → in_progress)
tq claim --agent <agent-id>

# Claim the highest-priority eligible task for a specific role
# (matches tasks with that assigned_role, or tasks with no assigned_role)
tq claim --agent <agent-id> --role <role>

# Claim the highest-priority draft task for refinement (draft → in_progress)
tq claim --draft --agent <agent-id>
```

### Terminal state (worker agent)

```bash
# Mark a task completed and write a result payload
tq complete <id> --agent <agent-id> -r '<json>'

# Mark a task failed with a reason
tq fail <id> --agent <agent-id> --reason '<text>'

# Release an in_progress task back to eligible (for retry after interruption)
tq release <id> --agent <agent-id>
tq release <id> --force          # operator override, skip agent check
```

The `--agent` value must match the `claimed_by` field set during `tq claim`.
Use `-r` or `--result` for the result payload on `tq complete`.

### Task-refiner agent

Draft tasks are claimed and refined by special task-refiner agents. After refining
(adding detail, splitting into sub-tasks, etc.) the refiner publishes the ticket:

```bash
# Mark a draft task as ready (in_progress → eligible or pending based on deps)
tq publish <id> --agent <agent-id>
```

`tq publish` transitions the task to `eligible` (if all dependencies are complete)
or `pending` (if it still has incomplete dependencies), making it available to
regular worker agents.

### Create tasks

```bash
# Enqueue a single task (created as 'draft' by default)
tq enqueue "<description>" \
  [--payload '<json>'] \
  [--depends-on <id>] \   # repeatable
  [--parent <id>] \
  [--priority <n>] \      # higher = claimed first; default 0
  [--created-by <id>] \
  [--assigned-role <role>] \  # route to a specific worker role
  [--ready]               # skip draft; create as eligible/pending immediately

# Batch-enqueue a task graph from a JSON file (or stdin with -)
tq batch <file>
tq batch -          # reads from stdin
tq batch <file> --ready  # skip draft for all tasks in the batch
```

### Task status lifecycle

```
draft → (task-refiner claims) → in_progress → (publish) → pending → eligible → in_progress → completed
                                                                   ↗                        → failed
                                            → (publish, no deps)  → eligible    ↖ (release)
```

New tasks start as `draft` unless `--ready` is passed.
`tq claim --draft` transitions `draft` → `in_progress` (for task-refiners only).
`tq publish` transitions `in_progress` → `eligible` or `pending` (based on deps).
`tq claim` transitions `eligible` → `in_progress` (for regular workers).
`tq release` transitions `in_progress` → `eligible` (for interrupted workers).
When all dependencies of a `pending` task complete, it becomes `eligible`.

### Planner commands (cross-task refinement)

These commands operate atomically on `main` and are safe while other agents work.
They only affect tasks in mutable states (draft, pending, eligible).

```bash
# Add a dependency edge: task depends on dep (with cycle detection)
tq link <task-id> <dep-id> [--agent <id>]

# Remove a dependency edge (may promote pending → eligible)
tq unlink <task-id> <dep-id> [--agent <id>]

# Move a task under a new parent (use "root" to unparent)
tq reparent <task-id> <new-parent-id|root> [--agent <id>]

# Edit task metadata (at least one field required)
tq edit <task-id> [--description <text>] [-p <json>] [--priority <n>] [--assigned-role <role>] [--agent <id>]

# Cancel a task without claiming (for duplicates / obsolete tasks)
tq cancel <task-id> --reason '<text>' [--agent <id>]
```

### Skills

Use these slash commands for common task-queue workflows:

- `/tq-complete <task-id> <result>` — mark a task completed with a result
- `/tq-fail <task-id> <reason>` — mark a task failed with a reason
- `/tq-subtask <parent-id> "<description>"` — create a child task

## Worker Roles

Worker roles are defined in `roles.json` at the workspace root. Adding a new role
requires only a JSON edit — no code change.

Each role specifies:
- `id` — role name, passed as `--role` to the worker
- `description` — human-readable summary (for conductors selecting a role)
- `claimDraft` — `true` for draft pool, `false` for eligible pool
- `systemPrompt` / `workPrompt` — arrays of lines, joined with `\n`

**Template variables** available in prompts:
- `{{agentId}}` — the agent's ID (ephemeral, generated fresh each run)
- `{{taskId}}` — the task being worked on
- `{{tagsLine}}` — `\nCapability tags: foo, bar` or empty string
- `{{logPath}}` — relative path to the task's JSONL work log
- `{{priorWorkNotice}}` — context recovery notice (non-empty if prior log exists)

**Built-in roles:**

| Role | Claims | Action |
|------|--------|--------|
| `implementer` | `eligible` tasks (no assigned_role or assigned_role=implementer) | Does the work → `tq complete` / `tq fail` |
| `refiner` | `draft` tasks | Refines one ticket → `tq publish` |
| `planner` | `eligible` tasks with assigned_role=planner | Cross-task refinement → `tq complete` with summary |

**Launching a worker with a role:**

```bash
worker --role implementer      # one-shot implementer (default)
worker --role refiner          # one-shot refiner
worker --role planner          # one-shot planner (claims planner-assigned task)
worker --task-id <id>          # conducted mode: claim a specific task
WORKER_ROLE=planner worker     # via env var
```

Agent IDs are always ephemeral (randomUUID on each run). There is no
`--agent-id` or `--resume-session` flag — context recovery is handled
via the task-centric work log and git worktree.

Override the roles file location with `ROLES_CONFIG=/path/to/roles.json`.

### Worker output protocol

On startup, the worker emits a single JSON metadata line to **stdout**, then
**closes stdout**. This lets an orchestrator read the line and detach without
staying connected for the lifetime of the run.

```json
{"agent_id":"...","task_id":"...","role":"implementer","session_id":"...","log_path":"data/work-logs/tq-xxxx.jsonl","pid":12345}
```

The `log_path` points to the JSONL stream-json capture (keyed by task ID).

**Exit codes:**
- `0` — task completed or failed by the agent
- `75` — rate limited (task was released back to eligible, retry later)
- `1` — config error or spawn failure
- Other — unexpected crash

**Interactive mode**: When stderr is a TTY (or `--interactive` is passed),
the worker streams human-readable Claude output to stderr — thinking, text,
tool calls, and results — so a human can watch progress. In non-interactive
mode (e.g. orchestrator-spawned), stderr is silent after initial diagnostics.

```bash
worker --role refiner --interactive    # force human-readable stderr
worker --role refiner --no-interactive # force silent mode
```

## Operator Tool CLI

The `work` command is the human operator tool for monitoring and administering the fleet.

```bash
# Tail a worker's log in realtime (accepts worker UUID or task ID)
work watch <id>

# Launch the full-screen terminal dashboard
work dashboard    # or: work dash
```

### Dashboard

`work dashboard` shows a full-screen blessed TUI with four panels:
- **Fleet Status** — task counts by status (poll DB every 3s)
- **Active Workers** — in_progress tasks with agent ID, description, elapsed time
- **Worker Log** — realtime tail of the selected worker's JSONL log
- **Task Pipeline** — tree view of all tasks with status indicators

Keyboard: `Tab` switch panel, `↑↓` navigate, `r` refresh, `q` quit.

### Work logs

Worker invocations are captured to `data/work-logs/<task-id>.jsonl`
as stream-json output from Claude. Each line is a JSON event.
Logs are append-only — retries on the same task append to the same file,
giving a complete timeline of all attempts.
