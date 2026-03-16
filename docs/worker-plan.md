# Worker — Implementation Plan

Goal: a thin `packages/worker` Node.js/TypeScript launcher that receives a task ID (from the conductor or CLI), spawns `claude -p` with that task ID in the prompt, and exits. The agent completes the task using the `tq` CLI and its normal tool set. No DB access, no HTTP calls, no task parsing in the launcher.

---

## Architecture

```
Conductor (future)
  └─► worker --task-id tq-a1b2
        │
        └─► spawn: claude -p "Complete task tq-a1b2"
                     │
                     ├─ Bash: tq get tq-a1b2        (read task)
                     ├─ Bash: tq dep-results tq-a1b2 (read inputs)
                     ├─ ... do the work ...
                     ├─ /tq-complete tq-a1b2         (skill)
                     │    └─ Bash: tq complete ...
                     └─ exit
```

The conductor is responsible for claiming the task before invoking the worker. The worker assumes the task is already `in_progress` and `claimed_by` this agent. The worker's only DB interactions are reads (`tq get`, `tq dep-results`) and the terminal write (`tq complete` / `tq fail`).

---

## How the agent learns about the task queue

Three layers, each with a different scope:

| Layer | What it contains | Where it lives |
|-------|-----------------|----------------|
| `CLAUDE.md` | `tq` CLI reference: all commands, flags, output format | Repo root — always in context |
| Project skills | Workflow patterns: complete, fail, create subtask | `.claude/commands/tq-*.md` |
| System prompt | Agent identity only: agent ID, tags, one-liner on role | Worker launcher — injected at spawn time |

The system prompt intentionally contains no schema or SQL. The CLI and skills handle all task queue interactions; the agent uses them naturally via its Bash tool and slash commands.

---

## `tq` CLI (assumed interface)

The task queue CLI is a separate package (`packages/tq-cli` or a binary built from `queue-server`). The worker plan assumes the following commands exist; the CLI plan specifies their implementation:

```
tq get <id>                     # print task JSON
tq dep-results <id>             # print {depId: result_payload, ...} JSON
tq complete <id> --result <json># mark completed, write result_payload
tq fail <id> --reason <string>  # mark failed
tq create ...                   # enqueue a new task (for subtasks)
```

All commands exit 0 on success, non-zero on error, and write JSON to stdout.

---

## Project skills

Three skills, added as project-level slash commands in `.claude/commands/`:

### `/tq-complete`

```
Usage: /tq-complete <task-id> <result-json-or-summary>

Marks a task queue task as completed. Steps:
1. Run: tq complete <task-id> --result '<result>'
2. Verify exit code 0.
3. Confirm by running: tq get <task-id> and checking status === "completed".
```

### `/tq-fail`

```
Usage: /tq-fail <task-id> <reason>

Marks a task queue task as failed. Steps:
1. Run: tq fail <task-id> --reason '<reason>'
2. Verify exit code 0.
```

### `/tq-subtask`

```
Usage: /tq-subtask <parent-id> <description> [--tags <tags>] [--deps <ids>]

Creates a child task under the given parent. Steps:
1. Run: tq create --parent <parent-id> --description '<description>' [--tags ...] [--deps ...]
2. Print the new task ID.
```

Skills are the canonical way for the agent to interact with task state. The agent should prefer `/tq-complete` over a raw `tq complete` shell call, since the skill includes the verification step.

---

## System prompt (minimal)

```
You are an autonomous software engineering agent.
Agent ID: {{AGENT_ID}}
Capability tags: {{AGENT_TAGS}}

You will be given a task ID. Use the tq CLI (documented in CLAUDE.md) to read
the task and its dependency results, then complete the work. When done, use
/tq-complete to record your result. If you cannot complete the task, use
/tq-fail with a clear reason.

The task is already claimed. Do not attempt to claim or release it.
```

---

## Package structure

```
packages/worker/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts        # CLI entrypoint: parse --task-id, spawn claude, exit
    ├── config.ts       # Typed config from env + CLI args
    └── launcher.ts     # Builds argv, spawns claude, streams output, resolves exit

.claude/commands/
    ├── tq-complete.md
    ├── tq-fail.md
    └── tq-subtask.md

CLAUDE.md              # Gets a new "Task Queue CLI" section
```

---

## Configuration

| Source | Var / Flag | Required | Default | Notes |
|--------|-----------|----------|---------|-------|
| CLI arg | `--task-id` | yes | — | Task to execute |
| env | `AGENT_ID` | no | `worker-<hostname>-<pid>` | Substituted into system prompt |
| env | `AGENT_TAGS` | no | `""` | Substituted into system prompt |
| env | `WORK_DIR` | no | `process.cwd()` | Working directory for claude subprocess |
| env | `CLAUDE_MODEL` | no | `sonnet` | Passed to `--model` |
| env | `CLAUDE_MAX_BUDGET_USD` | no | unset | Per-invocation cost cap |

No `DOLT_*` vars — the worker does not connect to the DB directly.

---

## Implementation tasks

---

### W01 — Package scaffold

`packages/worker/` with `package.json`, `tsconfig.json`, `vitest.config.ts`, empty `src/index.ts`.

**Depends on:** T01

---

### W02 — Config module

`src/config.ts` — parses `--task-id` (required) and env vars into `WorkerConfig`. Throws on missing task ID.

**Depends on:** W01

---

### W03 — Project skills

Create `.claude/commands/tq-complete.md`, `tq-fail.md`, `tq-subtask.md` with the workflow patterns above.

**Depends on:** nothing (can be written independently)

---

### W04 — CLAUDE.md task queue section

Add a "Task Queue CLI" section to the root `CLAUDE.md` documenting all `tq` commands, flags, and output format. This is the ambient reference Claude reads automatically.

**Depends on:** `tq` CLI being specced (can be a placeholder until then)

---

### W05 — Launcher

`src/launcher.ts` — renders the system prompt (substitutes `AGENT_ID`, `AGENT_TAGS`), builds claude argv, spawns subprocess, pipes stderr to process stderr, resolves `{ exitCode }` on exit.

**Depends on:** W02

---

### W06 — Entrypoint

`src/index.ts` — validates config, calls `runClaude`, exits with the same code.

**Depends on:** W05

---

### W07 — Smoke test

`test/smoke.test.ts` — requires a live queue server and a pre-inserted `in_progress` task. Spawns the worker against that task ID, waits for exit, queries the queue server to assert `status === 'completed'`.

**Depends on:** W06, T15 (queue server)

---

## Dependency graph

```
W03  W04   (independent, write anytime)

T01
 └── W01
      └── W02
           └── W05
                └── W06
                     └── W07 (also needs T15)
```

Linear critical path: **T01 → W01 → W02 → W05 → W06**

---

## What is out of scope for MVP

| Feature | Reason deferred |
|---------|----------------|
| Polling loop / conductor logic | Conductor is a separate component; worker is single-shot |
| Task claiming in the worker | Conductor's responsibility |
| Per-task git worktree isolation | Post-MVP |
| Heartbeat / orphan recovery | Mirrors queue server deferral |
| Retry on claude process error | Post-MVP |
| Docker compose entry | Add after end-to-end loop works |
