# Conductor Architecture

> Generated 2026-03-17 by architecture review task tq-508a12f455ab.

## Overview

The **conductor** is the central orchestrator of the Shardworks worker fleet. It runs as a background daemon process that:

1. **Monitors** the task queue (via Dolt/MySQL) for work that needs doing.
2. **Spawns** worker processes to claim and execute tasks.
3. **Reaps** stale tasks whose workers have died.
4. **Drains** a signal file written by workers to learn about rate limits, crashes, and merge failures.
5. **Alerts** humans via webhooks and sentinel tasks when intervention is needed.
6. **Cleans up** stale git worktrees for completed/failed tasks.

The conductor does **not** execute task logic itself — it is purely an orchestration layer. Workers are spawned as detached child processes and communicate back via the signal file and the Dolt database.

### Key files

| File | Purpose |
|------|---------|
| `cli.ts` | CLI entry point (`conductor start/stop/status/logs/_daemon`) |
| `daemon.ts` | Daemon loop, manager pipeline orchestration, interruptible sleep |
| `managers/manager.ts` | Manager interface and TickContext type |
| `managers/index.ts` | Default pipeline factory, re-exports |
| `managers/signal-drain.ts` | Reads worker signals, routes spawn_requests vs operational signals |
| `managers/reaper.ts` | Finds and releases stale in_progress tasks |
| `managers/spawner.ts` | Capacity assessment, spawn decision logic, worker spawning |
| `managers/janitor.ts` | Periodic worktree cleanup |
| `scheduler.ts` | **Legacy** — contains dead `DefaultScheduler` class + shared refiner constants |
| `state.ts` | ConductorState type, PID management, structured logging, file I/O |
| `config.ts` | ConductorConfig type and `loadConfig()` with validation |
| `alerts.ts` | Alert system with cooldowns, webhooks, sentinel tasks |
| `signals.ts` | Signal file reading/writing (conductor-signals.jsonl) |
| `spawn.ts` | `spawnWorker()`, `reapStale()`, `runTq()` helpers |
| `db.ts` | MySQL connection pool and `queryCounts()` |

---

## Process Model

### Daemon lifecycle

```
conductor start → (lock check) → spawn detached _daemon process → write PID → exit
_daemon → loadConfig() → runDaemon(cfg) → main loop (never returns)
conductor stop → read PID → SIGTERM → poll for exit → SIGKILL fallback → clear PID
```

The `start` command uses an **exclusive file lock** (`conductor-start.lock`, `O_CREAT|O_EXCL`) to prevent two concurrent `conductor start` commands from racing. The lock is held only during the check-and-spawn sequence.

### PID management

- PID is written to `data/conductor.pid` by the `start` command (not the daemon itself).
- PID is cleared by: (1) the `stop` command, (2) the daemon's shutdown handler, (3) `stop` if PID is stale.
- `isAlive(pid)` uses `process.kill(pid, 0)` (signal 0 = existence check).

### Signal handling & graceful shutdown

- SIGTERM/SIGINT handlers set `stopping = true`, call `saveState()`, `closePool()`, `clearPid()`, then `process.exit(0)`.
- **Known issue**: shutdown can close the DB pool while a tick is mid-query (see deficiency tickets).

---

## Manager Pipeline

### The Manager interface

```typescript
interface Manager {
  readonly name: string;
  run(ctx: TickContext): Promise<ManagerResult>;
}

interface ManagerResult {
  abort?: boolean;
  summary?: Record<string, unknown>;
}

interface TickContext {
  cfg: ConductorConfig;
  state: ConductorState;
  log: LogFn;
  setPhase: (p: Phase) => void;
  shutdown: (reason: string) => Promise<void>;
  shared: Record<string, unknown>;  // per-tick inter-manager communication
}
```

### Execution order

Managers run **sequentially** in a deterministic order during each tick:

1. **signal-drain** — must run first to capture rate-limit/crash signals
2. **reaper** — release stale tasks before assessing capacity
3. **spawner** — fill slots and handle spawn requests
4. **janitor** — background cleanup (throttled)

### Abort semantics

If a manager returns `{ abort: true }`, the remaining managers are **skipped** for this tick. Currently only the signal-drain manager aborts (on rate-limit signals). The tick still completes (state is saved, phase reset to idle).

### Fault isolation

If a manager **throws**, the error is logged and the pipeline **continues** with the next manager. This prevents a bug in one manager from blocking all others.

### Adding a new manager

1. Implement the `Manager` interface.
2. Insert it at the appropriate position in `createDefaultManagers()` in `managers/index.ts`.
3. The daemon passes an optional `managers` parameter to `runDaemon()` for testing.

---

## Each Manager in Detail

### signal-drain (`managers/signal-drain.ts`)

**What it does**: Reads new lines from `data/conductor-signals.jsonl` using a byte-offset cursor. Separates `spawn_request` signals (forwarded to spawner via `ctx.shared`) from operational signals (`rate_limited`, `crashed`, `merge_failed`).

**Key decisions**:
- Uses `readNewSignals()` which reads from the file byte offset, not line count. Handles file truncation by resetting offset.
- Spawn requests are passed through `ctx.shared[PENDING_SPAWN_REQUESTS_KEY]`.
- Operational signals trigger `processSignals()` → `fireAlert()`.

**Edge cases / issues**:
- **Bug**: If rate_limited signal aborts the tick, `ctx.shared[PENDING_SPAWN_REQUESTS_KEY]` is never set, silently dropping spawn_requests in the same batch.

### reaper (`managers/reaper.ts`)

**What it does**: Calls `tq reap --stale-after <duration> --release` to find and release tasks stuck in `in_progress` beyond the threshold.

**Key decisions**:
- Delegates entirely to the `tq` CLI subprocess.
- Non-fatal: logs warning on failure, continues.
- Updates `state.stats.tasksReaped`.

### spawner (`managers/spawner.ts`)

**What it does**: The most complex manager. Handles the full assess → decide → spawn pipeline:

1. **Load known roles** from `roles.json` (fallback: hardcoded defaults).
2. **Query DB** for task counts by status and role.
3. **Check capacity** (at maxWorkers? rate-limited?).
4. **Compute refiner policy** (cap = 40% of maxWorkers, floor = 10%).
5. **Decide spawns** using `decideNextAction()` — priority-aware draft vs eligible comparison.
6. **Execute spawns** — call `spawnWorker()` for each decided role.
7. **Handle operator spawn_requests** — bypass maxWorkers cap.

**Key decisions**:
- Refiner floor is force-spawned regardless of eligible task priority (prevents refiner starvation).
- Refiner cap prevents refiners from consuming all slots.
- Priority comparison: highest-priority draft vs highest-priority eligible determines refiner vs worker.
- `eligibleBlockedByChildren` subtracts parent containers whose children need refining.
- Spawn requests bypass capacity limits (operator override).

### janitor (`managers/janitor.ts`)

**What it does**: Periodically scans `.claude/worktrees/` for directories matching `tq-*`. For each, checks if the task is terminal (completed/failed/cancelled) and the worktree has no uncommitted changes, then removes it via `git worktree remove`.

**Key decisions**:
- **Throttled**: runs at most once per `cleanupIntervalMs` (default: 5 minutes).
- **Safe**: checks `git status --porcelain` before removal; assumes dirty on any error.
- **Fallback**: if `git worktree remove` fails, falls back to `rm -rf`.

---

## State Management

### ConductorState

```typescript
interface ConductorState {
  phase: Phase;                              // starting|idle|reaping|assessing|spawning|waiting|stopping
  lastTickAt: string | null;
  lastNoWorkAt: string | null;
  rateLimitedUntil: string | null;           // ISO timestamp for spawn suppression
  signalFileOffset: number;                  // byte offset into signals file
  lastAlertAt: Partial<Record<AlertType, string>>;  // cooldown tracking
  activeWorkers: ActiveWorker[];
  stats: ConductorStats;                     // tickCount, workersSpawned, tasksReaped, startedAt
  managers?: string[];                       // names of active managers
}
```

### Persistence

- State is written atomically (write to `.tmp`, rename) via `writeState()`.
- Writes are serialized through a `saveQueue` promise chain to prevent concurrent `.tmp` file races.
- On daemon restart, `signalFileOffset`, `lastAlertAt`, and `rateLimitedUntil` are restored. `activeWorkers` and `stats` are intentionally reset (stale PIDs are unreliable).

### rateLimitedUntil

Set when a `rate_limited` signal's `retry_after` exceeds the current hold. Checked by the spawner to suppress spawning. Cleared when the hold-off timestamp passes.

### activeWorkers tracking

- Updated only at spawn time (dead PIDs filtered, new worker appended).
- **Known issue**: no periodic reconciliation — stale entries persist until the next spawn.
- Used for: refiner count calculation, `conductor status` display.

---

## Worker Spawning (`spawn.ts`)

### How workers are spawned

`spawnWorker()` uses `child_process.spawn()` with `detached: true, stdio: 'ignore'`. The child is immediately `unref()`'d so the conductor is not blocked.

### Arguments passed to workers

- `--role <role>` — always
- `--task-id <taskId>` — if conducting a specific task (eliminates TOCTOU claim race)
- `--branch <branch>` — if not `main`

### Environment

- `WORK_DIR` — working directory
- `WORKER_BRANCH` — branch name
- `DOLT_DATABASE` — `shardworks/<branch>` (scopes all DB operations to the branch)

### Refiner cap/floor policy

- **Cap**: `Math.max(1, Math.floor(maxWorkers * 0.4))` — at most 40% of slots for refiners.
- **Floor**: `Math.max(1, Math.ceil(maxWorkers * 0.1))` — at least 10% reserved for refiners when drafts exist. Force-spawned regardless of eligible task priority.
- Constants currently live in `scheduler.ts` (legacy location).

---

## Signal System

### File: `data/conductor-signals.jsonl`

Workers append JSON lines to this file. The conductor reads new lines each tick using a byte offset cursor.

### Signal types

| Type | Written by | Effect |
|------|-----------|--------|
| `rate_limited` | Worker hitting API rate limit | Sets `rateLimitedUntil`, fires alert, aborts tick |
| `crashed` | Worker wrapper on non-zero exit | Fires alert |
| `merge_failed` | Worker wrapper on git merge failure | Fires alert |
| `spawn_request` | Operator via `conductor spawn` or API | Spawns worker (bypasses maxWorkers cap) |

### How workers write signals

Workers use `appendFile()` to append a JSON line. This is safe for concurrent appends on POSIX (append writes are atomic up to `PIPE_BUF`).

### How conductor drains signals

`readNewSignals()` in `signals.ts`:
1. `stat()` the file to get current size.
2. If size > offset, `createReadStream()` from offset to size-1.
3. Parse each line as JSON, skip malformed lines.
4. Return parsed signals and new offset.

---

## Alert System (`alerts.ts`)

### Alert types

- `rate_limited` — worker hit API rate limit (5 min cooldown)
- `task_exhaustion` — no draft or eligible tasks remain (60 min cooldown)
- `crashed` — worker process crashed (10 min cooldown)
- `merge_failed` — git worktree merge failed (10 min cooldown)

### Cooldowns

Each alert type has a cooldown period tracked in `state.lastAlertAt`. Repeated alerts of the same type within the cooldown are suppressed.

### Webhook integration

If `cfg.alertWebhook` is configured, a Slack-compatible JSON payload is POSTed with a 10-second timeout. Works with Slack, Discord `/slack` endpoint, ntfy.sh, and generic JSON receivers.

### Sentinel tasks

Each alert also creates a high-priority sentinel task (`assigned_role: 'human'`, `priority: 999`) in the queue. Dedup logic checks for existing uncompleted sentinels of the same type before creating a new one.

---

## Configuration (`config.ts`)

### ConductorConfig fields

| Field | Default | Validation |
|-------|---------|------------|
| `workDir` | `$WORK_DIR` or `cwd()` | None |
| `maxWorkers` | `$CONDUCTOR_MAX_WORKERS` or `3` | Must be finite integer >= 1 |
| `pollIntervalMs` | `$CONDUCTOR_POLL_INTERVAL * 1000` or `30000` | Must be positive finite integer |
| `staleAfter` | `$CONDUCTOR_STALE_AFTER` or `"30m"` | Must be non-empty string |
| `alertWebhook` | `$CONDUCTOR_ALERT_WEBHOOK` or `null` | None |
| `branch` | `$CONDUCTOR_BRANCH` or `"main"` | **None — missing validation** |

---

## Legacy Code

### `scheduler.ts` — DefaultScheduler

The `DefaultScheduler` class contains the **full pre-refactor scheduling logic** as a single monolithic `tick()` method. After the manager pipeline refactor, it is **dead code** — the daemon uses `runManagers()` with the manager pipeline instead.

**What is still used from this file**:
- `REFINER_MAX_FRACTION` (0.4) — imported by `spawner.ts`
- `REFINER_RESERVE_FRACTION` (0.1) — imported by `spawner.ts`
- `RefinerState` interface — imported by `spawner.ts`

**What is dead**:
- `Scheduler` interface — no consumers
- `DefaultScheduler` class — not instantiated anywhere
- All private methods: `assessCapacity`, `decideSpawns`, `decideNextAction`, `executeSpawns`, `doSpawn`, `loadKnownRoles`, `autoDetectRole`

The dead code is a maintenance hazard: developers may accidentally edit it thinking it is live.
