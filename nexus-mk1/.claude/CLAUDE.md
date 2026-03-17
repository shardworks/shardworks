# Shardworks

## Task Queue CLI

The `tq` command interacts with the Shardworks task queue backed by Dolt (MySQL-compatible).
All commands print JSON to stdout and exit 0 on success, non-zero on error.

### Read commands

```bash
tq show <id>                  # full task object
tq dep-results <id>           # result_payload of every direct dependency
tq list [--status draft|pending|eligible|in_progress|completed|failed] [--parent <id>] [--created-by <id>]
tq ready                      # all claimable tasks, highest priority first
tq subtree <id>               # all descendants with status rollup
```

### Terminal state

```bash
# Mark a task completed with a result payload
tq complete <id> --agent <agent-id> -r '<json>'

# Mark a task failed with a reason
tq fail <id> --agent <agent-id> --reason '<text>'

# Publish a refined draft (in_progress → eligible or pending based on deps)
tq publish <id> --agent <agent-id>
```

The `--agent` value must match `claimed_by`. Use `-r`/`--result` for the result payload.

### Create tasks

```bash
# Quick human-facing shorthand — all positional args become the description.
# Default priority is max(existing) + 1 so this task runs next.
tq add implement new login flow
tq add --ready fix typo in README   # skip draft, go straight to eligible
tq add --priority 50 investigate bug

tq enqueue "<description>" \
  [--payload '<json>'] \
  [--depends-on <id>] \    # repeatable
  [--parent <id>] \
  [--priority <n>] \       # higher = claimed first; default 0
  [--assigned-role <role>] \
  [--ready]                # skip draft; create as eligible/pending immediately

tq batch <file>            # batch-enqueue from JSON file (use - for stdin)
tq batch <file> --ready
```

### Task status lifecycle

```
draft → in_progress → (publish) → pending → eligible → in_progress → completed
                                ↗                                  → failed
                    → (publish, no deps) → eligible
```

New tasks start as `draft` unless `--ready` is passed. When all dependencies of a
`pending` task complete, it automatically becomes `eligible`.

### Operator commands

```bash
# Reset a completed or failed task for re-execution (operator override — no ownership check).
# Clears result, resets attempt_count to 0.  If the task was failed, blocked dependents
# are automatically un-blocked.  --work-dir triggers git worktree + branch cleanup.
tq reject <id> [--reason '<text>'] [--agent <id>] [--work-dir <path>]
```

### Planner commands

Safe to run while other agents work. Only affect tasks in mutable states (draft, pending, eligible).

```bash
tq link <task-id> <dep-id> [--agent <id>]                              # add dependency (cycle-checked)
tq unlink <task-id> <dep-id> [--agent <id>]                            # remove dependency
tq reparent <task-id> <new-parent-id|root> [--agent <id>]             # move under new parent
tq edit <task-id> [--description <text>] [-p <json>] [--priority <n>] [--assigned-role <role>] [--agent <id>]
tq cancel <task-id> --reason '<text>' [--agent <id>]                   # cancel duplicate/obsolete task
```