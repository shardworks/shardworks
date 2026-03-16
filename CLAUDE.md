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

# Claim the highest-priority draft task for refinement (draft → in_progress)
tq claim --draft --agent <agent-id>
```

### Terminal state (worker agent)

```bash
# Mark a task completed and write a result payload
tq complete <id> --agent <agent-id> -r '<json>'

# Mark a task failed with a reason
tq fail <id> --agent <agent-id> --reason '<text>'
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
                                            → (publish, no deps)  → eligible
```

New tasks start as `draft` unless `--ready` is passed.
`tq claim --draft` transitions `draft` → `in_progress` (for task-refiners only).
`tq publish` transitions `in_progress` → `eligible` or `pending` (based on deps).
`tq claim` transitions `eligible` → `in_progress` (for regular workers).
When all dependencies of a `pending` task complete, it becomes `eligible`.

### Skills

Use these slash commands for common task-queue workflows:

- `/tq-complete <task-id> <result>` — mark a task completed with a result
- `/tq-fail <task-id> <reason>` — mark a task failed with a reason
- `/tq-subtask <parent-id> "<description>"` — create a child task

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

Worker invocations are captured to `data/work-logs/<worker-id>/<task-id>.jsonl`
as stream-json output from Claude. Each line is a JSON event.
