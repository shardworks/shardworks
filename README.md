# Shardworks

An ongoing exploration into orchestrating fleets of agentic AIs — understanding how multiple autonomous AI agents can be coordinated, directed, and composed to accomplish complex tasks at scale.

## Architecture

Shardworks uses a **task-centric** model: a task queue (backed by Dolt) holds work items while thin worker processes spawn Claude Code agents to do the actual work. The task ID is the durable identity — all persistent state (DB records, git worktrees, JSONL logs) is keyed by it. Agent IDs are ephemeral. See [docs/architecture.md](docs/architecture.md) for the full design.

## Getting started

Clone the repo, open it in VS Code, and reopen in the Dev Container when prompted. The container builds and configures itself. See [docs/devcontainer.md](docs/devcontainer.md) for details on mounts, SSH agent filtering, and lifecycle scripts.

Once inside the container:

```bash
npm install        # install all workspace dependencies
npm run build      # build all packages
```

## CLI Tools

The project provides three CLI tools, all installed via `npm install` from the workspace root.

### `tq` — Task Queue

The primary interface for managing work. All commands print JSON to stdout and exit 0 on success.

```bash
# Enqueue a new task (starts as draft by default)
tq enqueue "Implement feature X" --priority 5 --assigned-role implementer

# List all tasks ready to be claimed
tq ready

# Claim the next eligible task for a role
tq claim --agent <agent-id> --role implementer

# Mark a task completed with a result summary
tq complete <task-id> --agent <agent-id> -r '{"summary": "done"}'

# Release a stuck task back to the queue (e.g. after a crash)
tq release <task-id> --force

# Find and release orphaned tasks that have been in_progress too long
tq reap --stale-after 30m --release
```

Other commands: `show`, `list`, `subtree`, `dep-results`, `batch`, `publish`, `fail`, `claim-id`, `link`, `unlink`, `reparent`, `edit`, `cancel`. Run `tq --help` for the full list.

### `worker` — Agent Worker

Spawns a Claude Code agent to work on a single task. Claims a task, launches `claude -p` with role-specific prompts, streams output to a JSONL log, and exits.

```bash
# Claim and work on the next eligible task (default role: implementer)
worker --role implementer

# Refine the next draft task
worker --role refiner

# Work on a specific task (conducted mode)
worker --task-id tq-0721ad7b

# Watch progress in real-time
worker --role implementer --interactive
```

Workers are fire-and-forget. On rate limits, the worker auto-releases the task and exits 75 so it can be retried. Exit 0 means the task was completed or failed by the agent. See [docs/architecture.md](docs/architecture.md) for the full exit code table.

### `work` — Operator Dashboard

Monitoring and administration for the human operator.

```bash
# Tail a task's JSONL log in real-time
work watch tq-0721ad7b

# Launch the full-screen terminal dashboard
work dashboard
```

The dashboard shows fleet status, active workers, a live log viewer, and the task pipeline tree. Keyboard: `Tab` to switch panels, `↑↓` to navigate, `r` to refresh, `q` to quit.

## Project Structure

```
packages/
  shared-types/   # TypeScript types shared across packages
  tq/             # Task queue CLI (backed by Dolt/MySQL)
  worker/         # Agent worker process (wraps claude -p)
  work/           # Operator monitoring tool & dashboard
roles.json        # Role definitions (implementer, refiner, planner)
docs/             # Architecture docs, devcontainer setup
```

## Devcontainer

Development happens inside a Docker-based devcontainer with Dolt, Node.js, Claude CLI, and GitHub CLI pre-installed. See [docs/devcontainer.md](docs/devcontainer.md) for prerequisites, bind mounts, SSH agent filtering, and lifecycle script details.
