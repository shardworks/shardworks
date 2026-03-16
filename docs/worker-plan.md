# Worker — Implementation Plan

Goal: a thin `packages/worker` Node.js/TypeScript launcher that receives a pre-created worker identity (agent ID + optional resume session), spawns `claude -p --output-format json` in a dedicated git worktree, and returns the captured session ID to the caller. The agent completes the task using the `tq` CLI. No DB access, no task parsing, no state files in the worker itself.

---

## Worker identity

The **conductor** pre-creates the worker identity before spawning. It must do this first because it needs the agent ID to call `tq claim --agent <id>`.

A worker identity consists of:

| Field | Source | Notes |
|-------|--------|-------|
| **Agent ID** | Conductor-generated UUID | Stable identifier. Used in `claimed_by`, `tq complete`, `tq fail`, and the git worktree name. |
| **Session ID** | Claude-generated (first run) | Captured from `--output-format json` output. Used for `--resume` on subsequent invocations. |

These are two distinct IDs. The agent ID is known before Claude ever runs. The session ID is discovered after the first invocation and handed back to the conductor for storage.

**Conductor lifecycle for a new worker:**
1. Generate agent UUID: `crypto.randomUUID()`
2. `tq claim --agent <uuid>` — atomically claims the task
3. `worker --task-id <id> --agent-id <uuid>` — spawn worker (no `--resume-session` on first run)
4. Worker exits → conductor reads session ID from worker's stdout
5. Store `(agent-id, session-id)` pair for future invocations

**Conductor lifecycle for a restarted worker:**
1. `worker --task-id <id> --agent-id <uuid> --resume-session <session-id>`

---

## Worktrees

Each worker runs in a dedicated git worktree tied to its agent ID. All invocations of the same worker — across process restarts, across multiple tasks in the session — use the same worktree.

### Native Claude support

On **first invocation**, the launcher passes `--worktree <agent-id>` to Claude. Claude creates the worktree and associates it with the session.

On **subsequent invocations**, the launcher passes `--resume <session-id>`. Claude restores the session and its associated worktree automatically.

The launcher does not manage worktree paths — Claude handles this natively through the session.

```
First run:
  claude -p --output-format json \
    --worktree <agent-id> \
    --permission-mode bypassPermissions \
    --model sonnet \
    "<prompt>"
  → creates worktree named <agent-id>
  → JSON output contains session_id

Subsequent runs (resume or restart):
  claude -p --output-format json \
    --resume <session-id> \
    --permission-mode bypassPermissions \
    --model sonnet \
    "<prompt>"
  → restores session + worktree
```

> **Assumption to verify:** `--resume` in `-p` mode restores the session's associated worktree without needing an explicit `--worktree` flag. Test this before building the launcher.

---

## State transitions

### Status lifecycle

```
pending ──(deps met)──► eligible ──(conductor claims)──► in_progress ──(worker)──► completed
                                                                │
                                                                └──(worker/supervisor)──► failed
```

### Transition ownership

| Transition | Owner | How |
|---|---|---|
| `eligible` → `in_progress` | **Conductor** | `tq claim --agent <agent-uuid>` before spawning worker |
| `in_progress` → `completed` | **Worker (agent)** | `/tq-complete` skill → `tq complete <id> --agent <agent-uuid> -r <json>` |
| `in_progress` → `failed` (task-level) | **Worker (agent)** | `/tq-fail` skill → `tq fail <id> --agent <agent-uuid> --reason <text>` |
| `in_progress` → `failed` (process crash) | **Supervisor** | Detects dead process; `tq fail <id> --agent <agent-uuid> --reason "max restarts exceeded"` |

### Worker exit contract

The worker exits 0 if the agent updated task state. It exits non-zero only on process-level failure before state was written. The supervisor uses exit code + `tq show <id>` status to decide whether to `--resume` and retry or call `tq fail`.

### Post-MVP: `assigned` status

When the queue server adds `assigned`, the conductor will use `tq assign` (not `tq claim`) so that assignment and process-start become separate transitions. The supervisor will handle `in_progress` → `assigned` resets on crash. The current `tq claim` atomically performs both.

---

## Architecture

```
Conductor
  ├─ uuid = crypto.randomUUID()
  ├─ tq claim --agent <uuid>                      (eligible → in_progress)
  └─ worker --task-id tq-a1b2 --agent-id <uuid> [--resume-session <sid>]
               │
               ├─ first run:  claude -p --output-format json --worktree <uuid> "<prompt>"
               └─ resume:     claude -p --output-format json --resume <sid>   "<prompt>"
                                        │
                                        │  (agent knows its identity from system prompt)
                                        ├─ Bash: tq show tq-a1b2
                                        ├─ Bash: tq dep-results tq-a1b2
                                        ├─ ... work in worktree ...
                                        └─ /tq-complete or /tq-fail (uses agent-id from prompt)
                                        │
                                        └─ JSON stdout → launcher extracts session_id
                                             └─ worker prints session_id → conductor stores it
```

---

## Prompt design

The prompt is generic. The agent reads task state itself and decides whether to continue or start fresh:

```
Your worker identity: agent ID = {{AGENT_ID}}

Use this agent ID as the --agent value in all tq commands (complete, fail).

Work on task {{TASK_ID}}.

Check the task with `tq show {{TASK_ID}}`. If the task is in_progress and you have
prior conversation history for it, continue from where you left off. If this is a
fresh start, read the description and payload, fetch dependency results with
`tq dep-results {{TASK_ID}}`, then do the work.

When done, use /tq-complete. If you cannot complete the task, use /tq-fail with a
clear reason.
```

---

## `tq` CLI reference

All commands exit 0 on success, non-zero on error. Output is JSON.

```bash
# Read
tq show <id>                                        # full task object
tq dep-results <id>                                 # { depId: result_payload, ... }
tq list [--status <s>] [--parent <id>] [--created-by <id>]
tq ready                                            # eligible tasks, priority order
tq subtree <id>                                     # descendants + status rollup

# Claim (conductor)
tq claim --agent <id>                               # eligible → in_progress; prints task

# Terminal state (worker agent)
tq complete <id> --agent <id> -r <json>             # in_progress → completed
tq fail <id> --agent <id> --reason <text>           # in_progress → failed

# Create tasks (agent, for subtasks)
tq enqueue "<description>" \
  [--payload <json>] \
  [--depends-on <id>] \                             # repeatable
  [--parent <id>] \
  [--priority <n>] \
  [--created-by <id>]

tq batch <file>                                     # batch-enqueue graph from JSON (- for stdin)
```

**Notes:**
- `--agent` on `complete` and `fail` is validated against `claimed_by` — must match the value used in `tq claim`
- `-r` is short for `--result` on `tq complete`
- `tq claim` has no `--tags` flag currently; tag filtering is not yet exposed in the CLI
- `tq batch` accepts `-` for stdin: `echo '[...]' | tq batch -`

---

## How the agent learns about the task queue

| Layer | What it contains | Where it lives |
|-------|-----------------|----------------|
| `CLAUDE.md` | Full `tq` CLI reference (commands, flags, examples) | Repo root — always in context |
| Project skills | Workflow patterns with verification steps | `.claude/commands/tq-*.md` |
| Launcher prompt | Agent ID + task ID + generic start-or-continue instruction | Injected at spawn time |

---

## Project skills

### `/tq-complete`

```
Usage: /tq-complete <task-id> <result>

Mark a task as completed. <result> is a JSON string or plain text summary.
1. Run: tq complete <task-id> --agent <your-agent-id> -r '<result>'
   (Your agent ID is in the system prompt under "agent ID =")
2. Verify exit code 0.
3. Confirm: tq show <task-id> → status should be "completed".
```

### `/tq-fail`

```
Usage: /tq-fail <task-id> <reason>

Mark a task as failed with a reason.
1. Run: tq fail <task-id> --agent <your-agent-id> --reason '<reason>'
   (Your agent ID is in the system prompt under "agent ID =")
2. Verify exit code 0.
```

### `/tq-subtask`

```
Usage: /tq-subtask <parent-id> "<description>" [--payload <json>] [--depends-on <id>]

Create a child task under a parent.
1. Run: tq enqueue "<description>" --parent <parent-id> --created-by <your-agent-id> [--payload ...] [--depends-on ...]
2. Note the new task ID from the output.
```

---

## System prompt

```
You are an autonomous software engineering agent.
Your agent ID: {{AGENT_ID}}

Use {{AGENT_ID}} as the --agent value in all tq complete and tq fail commands.

Refer to CLAUDE.md for the full tq CLI reference.
```

The launcher prompt (the user message passed to `-p`) contains the task ID and start-or-continue instruction. The system prompt contains only stable identity information.

---

## Package structure

```
packages/worker/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts        # CLI entrypoint; parses args, calls launcher, prints session_id, exits
    ├── config.ts       # Typed config from CLI args + env
    └── launcher.ts     # Builds argv (--worktree or --resume), spawns claude,
                        # parses JSON output, extracts session_id

.claude/commands/
    ├── tq-complete.md
    ├── tq-fail.md
    └── tq-subtask.md

CLAUDE.md               # Gets a "Task Queue CLI" section
```

---

## Configuration

| Source | Flag / Var | Required | Notes |
|--------|-----------|----------|-------|
| CLI arg | `--task-id` | yes | Task to work on |
| CLI arg | `--agent-id` | yes | Conductor-generated UUID; injected into prompt and used as worktree name on first run |
| CLI arg | `--resume-session` | no | Claude session UUID; absent on first run, required on restart |
| env | `AGENT_TAGS` | no | Injected into system prompt |
| env | `WORK_DIR` | no | Base working directory; defaults to repo root (claude subprocess CWD before worktree) |
| env | `CLAUDE_MODEL` | no | `sonnet` |
| env | `CLAUDE_MAX_BUDGET_USD` | no | Per-invocation cost cap |

**Output:** The launcher prints the captured `session_id` to stdout on exit. The conductor reads this and stores `(agent-id → session-id)` for future restarts.

---

## Implementation tasks

### W01 — Package scaffold

`packages/worker/` with `package.json`, `tsconfig.json`, `vitest.config.ts`, empty `src/index.ts`.

**Depends on:** T01

---

### W02 — Config module

`src/config.ts` — parses `--task-id`, `--agent-id` (both required), `--resume-session` (optional), and env vars into `WorkerConfig`.

**Depends on:** W01

---

### W03 — Launcher

`src/launcher.ts`:
- If `resumeSession` is absent: build argv with `--worktree <agentId>`
- If `resumeSession` is present: build argv with `--resume <resumeSession>`
- Always include: `-p --output-format json --permission-mode bypassPermissions --model <model>`
- Constructs system prompt (substitutes `AGENT_ID`) and user prompt (substitutes `TASK_ID`)
- Spawns subprocess, pipes stderr to process stderr
- Accumulates stdout, parses JSON on exit, extracts `session_id`
- Resolves `{ exitCode, sessionId }`

**Depends on:** W02

---

### W04 — Entrypoint

`src/index.ts` — validates config, calls launcher, prints `session_id` to stdout, exits with subprocess exit code.

**Depends on:** W03

---

### W05 — Project skills

Create `.claude/commands/tq-complete.md`, `tq-fail.md`, `tq-subtask.md`.

**Depends on:** nothing

---

### W06 — CLAUDE.md task queue section

Add "Task Queue CLI" section to root `CLAUDE.md` matching the real CLI commands and flags above.

**Depends on:** nothing

---

### W07 — Smoke test

`test/smoke.test.ts` — requires live queue server (skips if absent):

1. Generate `agentId = crypto.randomUUID()`
2. `tq enqueue "Say hello world"` → task ID
3. `tq claim --agent <agentId>` → task in_progress
4. Spawn: `worker --task-id <id> --agent-id <agentId>`; capture printed session_id
5. Assert exit code 0; `tq show <id>` → `status === "completed"`
6. Verify worktree was created (check `git worktree list`)
7. Re-spawn with `--resume-session <captured-sid>` on same (now completed) task — assert Claude reads status and exits cleanly without re-doing work

**Depends on:** W04, T15

---

## Dependency graph

```
W05  W06   (independent)

T01
 └── W01
      └── W02
           └── W03
                └── W04
                     └── W07 (also needs T15)
```

Linear critical path: **T01 → W01 → W02 → W03 → W04**

---

## What is out of scope for MVP

| Feature | Reason deferred |
|---------|----------------|
| `assigned` status + `tq assign` / `tq start` | Queue server addition required |
| Conductor / supervisor implementation | Separate components |
| Worktree cleanup / merge strategy | Post-MVP; one branch per worker accumulates work |
| Session rotation (context window management) | Post-MVP |
| Tag-based claim filtering in CLI | Not yet exposed in `tq claim` |
| Max-restart / give-up logic | Supervisor's responsibility |
| Docker compose entry | After end-to-end loop works |
