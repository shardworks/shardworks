# Worker — Implementation Plan

Goal: a `packages/worker` Node.js/TypeScript process that polls the task queue, claims eligible tasks, executes them by spawning the `claude` CLI in non-interactive mode, and reports results back. Single-task-at-a-time, no concurrency, no heartbeat — matching the MVP scope of the queue server.

---

## How it fits into the system

```
┌──────────────┐   POST /tasks/claim    ┌─────────────────┐
│  Queue Server│ ◄──────────────────── │                 │
│  (Fastify +  │                        │     Worker      │
│   Dolt)      │ ──── Task payload ───► │  (this package) │
│              │                        │                 │
│              │ ◄── POST /complete ─── │  spawns claude  │
│              │      or /fail          │  CLI subprocess │
└──────────────┘                        └─────────────────┘
```

The worker is a long-running process. It is stateless between polls; all durable state lives in the queue server.

---

## Claude CLI invocation strategy

The `claude` CLI is available at runtime (`claude -p` / `--print` flag). The worker spawns it as a child process per task:

```
claude \
  -p \
  --output-format json \
  --no-session-persistence \
  --permission-mode bypassPermissions \
  --model <CLAUDE_MODEL> \
  --system-prompt "<worker system prompt>" \
  "<task prompt>"
```

Key flags:
| Flag | Purpose |
|------|---------|
| `-p` / `--print` | Non-interactive; prints response and exits |
| `--output-format json` | Structured JSON output; easy to parse result text |
| `--no-session-persistence` | Don't write session files to disk per invocation |
| `--permission-mode bypassPermissions` | Automated operation; no interactive permission prompts |
| `--model` | Configurable model; defaults to `sonnet` |
| `--system-prompt` | Worker-level instructions prepended to every task |
| `--max-budget-usd` | Optional cost cap per task invocation |

The subprocess inherits the worker's working directory (configurable via `WORK_DIR` env var, defaults to the repo root). For MVP, all tasks share the same working directory; per-task isolation via `--worktree` is post-MVP.

### Output format

`--output-format json` emits a single JSON object to stdout:

```json
{
  "type": "result",
  "subtype": "success",
  "result": "<final response text>",
  "session_id": "...",
  "total_cost_usd": 0.012,
  ...
}
```

The worker extracts `result` as the string to store in `result_payload`. On non-zero exit code or `subtype: "error_during_execution"`, it calls `/fail` instead.

---

## Prompt construction

The worker assembles two pieces for each task:

**System prompt** (from `WORKER_SYSTEM_PROMPT` env or a compiled default):

> You are an autonomous software engineering agent. You will be given a task description and optional JSON payload. Complete the task to the best of your ability. Respond with a concise summary of what you did and any relevant output.

**User message** (built from the task record):

```
Task: <task.description>

Context:
<JSON.stringify(task.payload, null, 2) — omitted if payload is null>

Dependencies resolved:
<dep results JSON — omitted if no dependencies>
```

If the task has dependencies, the worker fetches `GET /tasks/:id/dep-results` before spawning Claude and includes the results in the prompt so downstream tasks can build on prior work.

---

## Worker loop

```
startup
  └─► validate config
  └─► log agent ID, tags, queue URL

loop (every POLL_INTERVAL_MS, default 5000):
  POST /tasks/claim { agentId, agentTags }
    ├─ null  ──► sleep, continue
    └─ Task  ──►
          fetch dep-results (if task has deps)
          build prompt
          spawn claude subprocess
              ├─ success  ──► POST /tasks/:id/complete { resultPayload }
              └─ error    ──► POST /tasks/:id/fail { reason }
          continue (no sleep; claim immediately after completing)

SIGTERM / SIGINT:
  set shutdown flag; finish current task if in progress; exit 0
```

No retry logic in MVP. If the queue call itself fails (network error), log and sleep.

---

## Package structure

```
packages/worker/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # CLI entrypoint; reads env, starts loop
│   ├── config.ts         # Typed config object from env vars
│   ├── queue-client.ts   # HTTP client: claim / complete / fail / dep-results
│   ├── prompt-builder.ts # Task → { systemPrompt, userMessage }
│   ├── claude-runner.ts  # Spawn claude subprocess, parse JSON output
│   └── worker.ts         # Main loop orchestration
└── test/
    └── smoke.test.ts     # Integration test (needs running queue + dolt)
```

Depends on `packages/shared-types` for `Task`, `ClaimResult`, etc. No additional runtime dependencies beyond what's already in the monorepo (`node-fetch` or native `fetch` for Node 18+).

---

## Configuration

All config via environment variables:

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `QUEUE_URL` | yes | — | Base URL of queue server, e.g. `http://localhost:3000` |
| `AGENT_ID` | no | `worker-<hostname>-<pid>` | Identifies this worker in `claimed_by` |
| `AGENT_TAGS` | no | `[]` | Comma-separated capability tags, e.g. `typescript,git` |
| `POLL_INTERVAL_MS` | no | `5000` | Milliseconds between claim attempts when queue is empty |
| `WORK_DIR` | no | `process.cwd()` | Working directory for claude subprocess |
| `CLAUDE_MODEL` | no | `sonnet` | Passed to `--model` |
| `CLAUDE_PERMISSION_MODE` | no | `bypassPermissions` | Passed to `--permission-mode` |
| `CLAUDE_MAX_BUDGET_USD` | no | unset | Passed to `--max-budget-usd` if set |
| `CLAUDE_EXTRA_FLAGS` | no | `""` | Appended verbatim to the claude invocation (escape hatch) |
| `WORKER_SYSTEM_PROMPT` | no | built-in default | Override system prompt for all tasks |

---

## Implementation tasks

Each task depends on the ones listed. Tasks at the same dependency level can be worked in parallel.

---

### W01 — Package scaffold

Create `packages/worker/` with:
- `package.json`: name `@shardworks/worker`, scripts for `build`, `dev`, `test`; depends on `@shardworks/shared-types`
- `tsconfig.json`: extends root, `outDir: dist`, `rootDir: src`
- `vitest.config.ts`: mirrors queue-server config
- Empty placeholder `src/index.ts`

**Depends on:** T01 (monorepo scaffold must exist)

---

### W02 — Config module

`src/config.ts` — reads and validates env vars, exports a typed `WorkerConfig` object. Throws a descriptive error at startup if `QUEUE_URL` is missing.

**Depends on:** W01

---

### W03 — Queue API client

`src/queue-client.ts` — thin typed HTTP client using native `fetch`:

```ts
claimTask(agentId: string, agentTags: string[]): Promise<Task | null>
completeTask(taskId: string, agentId: string, resultPayload: unknown): Promise<void>
failTask(taskId: string, agentId: string, reason: string): Promise<void>
getDepResults(taskId: string): Promise<Record<string, unknown>>
```

Throws a typed `QueueClientError` on non-2xx responses.

**Depends on:** W01

---

### W04 — Prompt builder

`src/prompt-builder.ts` — pure function, no I/O:

```ts
buildPrompt(task: Task, depResults: Record<string, unknown>): {
  systemPrompt: string;
  userMessage: string;
}
```

Serializes `task.description`, `task.payload`, and dep results into the user message as described above. System prompt comes from config.

**Depends on:** W01

---

### W05 — Claude runner

`src/claude-runner.ts` — spawns the `claude` CLI subprocess:

```ts
interface ClaudeResult {
  text: string;
  costUsd?: number;
}

runClaude(
  systemPrompt: string,
  userMessage: string,
  config: WorkerConfig
): Promise<ClaudeResult>
```

- Builds the argv array from config flags
- Spawns `claude` with `stdio: ['pipe', 'pipe', 'pipe']`
- Pipes stderr to `process.stderr` with a `[claude]` prefix
- Accumulates stdout, parses as JSON on exit
- Rejects on non-zero exit code or `subtype !== 'success'`

**Depends on:** W02, W04

---

### W06 — Main worker loop

`src/worker.ts` — orchestrates the poll → claim → execute → report cycle:

```ts
runWorkerLoop(config: WorkerConfig, client: QueueClient): Promise<void>
```

Handles shutdown flag, per-task error catching (a task failure must not crash the loop), and logging of each transition.

**Depends on:** W03, W05

---

### W07 — CLI entrypoint

`src/index.ts` — validates config, constructs dependencies, calls `runWorkerLoop`. Registers `SIGTERM`/`SIGINT` handlers. Logs startup banner (agent ID, tags, queue URL, model).

**Depends on:** W06

---

### W08 — Smoke test

`test/smoke.test.ts` — integration test that requires `QUEUE_URL` to point at a live queue server:

1. Enqueue a trivial task (`description: "echo hello"`, no tools needed)
2. Start the worker loop for one iteration
3. Assert the task transitions to `completed` and `result_payload` is populated

Skips automatically if `QUEUE_URL` is not set (for CI without the compose stack).

**Depends on:** W07, T15 (queue server must be complete)

---

## Dependency graph

```
T01 (monorepo)
 └── W01
      ├── W02 ──────────────────┐
      ├── W03 ──────────────┐   │
      └── W04 ──────────────┼───┴── W05
                            │        │
                            └────────┴── W06
                                          │
                                         W07
                                          │
                                         W08 (also needs T15)
```

Linear critical path: **T01 → W01 → W02 → W05 → W06 → W07**

---

## What is out of scope for MVP

| Feature | Reason deferred |
|---------|----------------|
| Concurrent task execution | Adds complexity around shared working directory and resource limits |
| Per-task git worktree isolation (`--worktree`) | Useful but not required for basic dogfooding |
| Heartbeat / task timeout / auto-release | Mirrors queue server deferral |
| Retry on claim/complete failure | Post-MVP; manual re-run is acceptable |
| Metrics / Prometheus endpoint | Use logs for now |
| Docker image / compose service entry | Add after the loop works end-to-end |
