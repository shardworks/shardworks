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
tq list [--status pending|eligible|in_progress|completed|failed] [--parent <id>] [--created-by <id>]

# List all currently claimable tasks, highest priority first
tq ready

# Show all descendants of a task with a status rollup
tq subtree <id>
```

### Claim (conductor)

```bash
# Atomically claim the highest-priority eligible task for an agent (eligible → in_progress)
tq claim --agent <agent-id>
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

### Create tasks

```bash
# Enqueue a single task
tq enqueue "<description>" \
  [--payload '<json>'] \
  [--depends-on <id>] \   # repeatable
  [--parent <id>] \
  [--priority <n>] \      # higher = claimed first; default 0
  [--created-by <id>]

# Batch-enqueue a task graph from a JSON file (or stdin with -)
tq batch <file>
tq batch -   # reads from stdin
```

### Task status lifecycle

```
pending → eligible → in_progress → completed
                                 → failed
```

A task starts as `eligible` if it has no dependencies, otherwise `pending`.
When all dependencies complete, the task becomes `eligible`.
`tq claim` transitions `eligible` → `in_progress`.

### Skills

Use these slash commands for common task-queue workflows:

- `/tq-complete <task-id> <result>` — mark a task completed with a result
- `/tq-fail <task-id> <reason>` — mark a task failed with a reason
- `/tq-subtask <parent-id> "<description>"` — create a child task
