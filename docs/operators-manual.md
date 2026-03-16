# Operator's Manual

This manual covers day-to-day operation of a Shardworks fleet: starting and stopping the system, managing the task backlog, monitoring workers, and recovering from failures.

## Nexus — Interactive Operations Console

Nexus is a Claude Code agent persona purpose-built for operating Shardworks. It knows every `tq`, `conductor`, and `work` command, understands the task lifecycle, and can execute multi-step operational workflows on your behalf.

```bash
# Launch Nexus as your primary agent
claude --agent nexus

# Or from within an existing Claude Code session
/nexus
```

The agent definition lives at `.claude/agents/nexus.md`. Customize its prompt, tools, or model there.

## Starting the System

### 1. Start the database

The devcontainer starts Dolt automatically. Verify with:

```bash
dolt sql -q "SELECT 1"
```

### 2. Start the conductor

```bash
conductor start --max-workers 3 --poll-interval 30 --stale-after 30m
```

| Flag | Default | Purpose |
|------|---------|---------|
| `--max-workers` | 3 | Max concurrent worker processes |
| `--poll-interval` | 30 | Seconds between ticks |
| `--stale-after` | 30m | Reap in_progress tasks older than this |
| `--alert-webhook` | — | URL for Slack/Discord/ntfy.sh alerts |

The conductor writes its PID to `data/conductor.pid` and logs to `data/conductor.jsonl`.

### 3. Verify

```bash
conductor status          # shows phase, worker count, uptime
work dashboard            # full-screen TUI
```

## Stopping the System

```bash
conductor stop                    # graceful shutdown (waits for tick to finish)
conductor stop --timeout 5       # force-kill after 5 seconds
```

Workers in flight will finish their current task independently — they don't need the conductor to complete.

## Managing the Backlog

### Creating tasks

```bash
# Quick add — description from args, priority = max(existing) + 1
tq add fix the login bug

# Skip draft, go straight to eligible
tq add --ready fix the login bug

# Full control
tq enqueue "Implement OAuth2 flow" \
  --priority 100 \
  --assigned-role implementer \
  --payload '{"spec_url": "https://..."}' \
  --depends-on tq-abc123 \
  --ready

# Bulk enqueue
tq batch tasks.json --ready
```

### Viewing the queue

```bash
tq ready                          # claimable tasks, highest priority first
tq list --status eligible         # all eligible tasks
tq list --status in_progress      # what's being worked on now
tq list --status failed           # what broke
tq humans                         # tasks needing human attention
tq show <id>                      # full task object
tq subtree <id>                   # all descendants with status rollup
```

### Editing and organizing

```bash
tq edit <id> --priority 500       # reprioritize
tq edit <id> --description "..."  # reword
tq edit <id> --assigned-role planner
tq link <id> <dep-id>            # add dependency (cycle-checked)
tq unlink <id> <dep-id>          # remove dependency
tq reparent <id> <parent-id>     # move under a different parent
tq reparent <id> root            # promote to top-level
tq cancel <id> --reason "duplicate of tq-xyz"
```

### Priority conventions

Higher priority = claimed first. Suggested ranges:

| Range | Use |
|-------|-----|
| 1000+ | Urgent / operator-escalated |
| 100–999 | Normal feature work |
| 1–99 | Background / low priority |
| 0 | Default (if not specified) |

`tq add` automatically assigns `max(existing) + 1` so new tasks run next.

## Monitoring

### Dashboard

```bash
work dashboard
```

Keyboard: `Tab` to switch panels, `Up/Down` to navigate, `r` to refresh, `q` to quit.

Panels: Fleet Status, Active Workers, Task Status Counts, Human Tasks, Conductor Logs, Selected Task Details.

### Logs

```bash
conductor logs                    # tail conductor activity (follow mode)
conductor logs -n 50 --no-follow  # last 50 lines
work watch <task-id>              # tail a specific task's work log
```

### Conductor status

```bash
conductor status
```

Shows: phase, uptime, worker count, recent tick stats, and any active rate-limit hold-offs.

## Worker Roles

The conductor spawns workers with a role that determines what they claim and how they behave.

| Role | Claims | Produces | Model |
|------|--------|----------|-------|
| `implementer` | eligible tasks (+ unassigned) | Code changes, `tq complete` | sonnet |
| `refiner` | draft tasks | Subtask decomposition, `tq publish` | sonnet |
| `planner` | eligible tasks with `assigned_role=planner` | Backlog grooming, `tq complete` | sonnet |

Role definitions live in `/workspace/roles.json`. Each role specifies system prompts, allowed tools, and claim behavior.

### Spawning logic

Each tick, the conductor:
1. Reaps stale in_progress tasks (releases them back to eligible)
2. Counts tasks by status
3. Compares top draft priority vs top eligible priority
4. Spawns refiner or implementer accordingly, up to `--max-workers`

## Failure Recovery

### Stuck tasks (in_progress but no worker)

Workers crash, get OOM-killed, or lose connectivity. The conductor's reaper handles this automatically (`--stale-after`), but you can intervene manually:

```bash
# See what's stale
tq reap --stale-after 15m

# Release them
tq reap --stale-after 15m --release

# Or release a specific task
tq release <id> --force
```

### Failed tasks

```bash
tq list --status failed
tq show <id>                      # check fail_reason and result_payload

# Retry (resets to eligible, increments attempt_count)
tq retry <id>

# Or cancel if it's not worth retrying
tq cancel <id> --reason "not fixable without design change"
```

### Rate limits

Workers detect rate limits automatically: they release the task and exit with code 75. The conductor pauses spawning briefly. No operator action needed unless rate limits persist — in that case, reduce `--max-workers`.

### Merge conflicts

When a worker's worktree can't merge cleanly into main, it emits a `merge_failed` signal. The conductor creates a human-attention task. Resolve by:

1. Finding the worktree: `ls .claude/worktrees/`
2. Manually merging or cherry-picking
3. Cancelling the attention task: `tq cancel <id> --reason "resolved"`

## Task Lifecycle Reference

```
draft ──→ in_progress ──→ publish ──→ pending ──→ eligible ──→ in_progress ──→ completed
         (refiner claims)             (has deps)              (implementer)
                         ──→ eligible                                      ──→ failed
                            (no deps)

Any mutable state ──→ cancelled (via tq cancel)
```

### Status meanings

| Status | Meaning |
|--------|---------|
| `draft` | Needs refinement before implementation |
| `pending` | Waiting on dependency tasks to complete |
| `eligible` | Ready to be claimed by a worker |
| `in_progress` | Claimed and being worked on |
| `completed` | Done — `result_payload` contains output |
| `failed` | Broken — check `fail_reason` |
| `cancelled` | Manually removed from queue |

## File Layout

```
data/
  conductor.pid               # PID of running conductor
  conductor-state.json        # persistent conductor state
  conductor.jsonl             # structured conductor logs
  conductor-signals.jsonl     # worker → conductor signals
  work-logs/<task-id>.jsonl   # per-task agent work logs
roles.json                    # role definitions
.claude/agents/nexus.md       # Nexus operator agent
```
