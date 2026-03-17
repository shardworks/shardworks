import type { Manager, ManagerResult, TickContext } from './manager.js';
import type { SpawnRequestSignal } from '../signals.js';
import type { TaskCounts } from '../db.js';
import type { SpawnedWorker } from '../spawn.js';
import { isAlive } from '../state.js';
import { queryCounts } from '../db.js';
import { spawnWorker } from '../spawn.js';
import { fireAlert } from '../alerts.js';
import {
  REFINER_MAX_FRACTION,
  REFINER_RESERVE_FRACTION,
  type RefinerState,
} from '../scheduler.js';
import { PENDING_SPAWN_REQUESTS_KEY } from './signal-drain.js';

// ---------------------------------------------------------------------------
// SpawnerManager
// ---------------------------------------------------------------------------

/**
 * Decide what workers to spawn and spawn them.
 *
 * Responsibilities:
 *   - Query the DB for current task counts.
 *   - Apply rate-limit and capacity checks.
 *   - Compute refiner cap/floor policy.
 *   - Decide spawn roles for available slots.
 *   - Execute spawns and update state.
 *   - Handle operator-initiated spawn_request signals (bypass maxWorkers cap).
 *
 * This manager consolidates the assess → decide → spawn pipeline that was
 * previously spread across steps 2-4 of the monolithic tick function.
 */
export class SpawnerManager implements Manager {
  readonly name = 'spawner';

  async run(ctx: TickContext): Promise<ManagerResult> {
    // ------------------------------------------------------------------
    // 1. Assess current capacity
    // ------------------------------------------------------------------
    ctx.setPhase('assessing');

    // Load known roles once per tick
    let knownRoles: Set<string>;
    try {
      knownRoles = await this.loadKnownRoles(ctx.cfg.workDir);
    } catch {
      knownRoles = new Set(['implementer', 'refiner']);
    }

    let counts: TaskCounts;
    try {
      counts = await queryCounts();
    } catch (err) {
      ctx.log('error', 'DB query failed, skipping spawn step', { error: String(err) });
      ctx.setPhase('idle');
      return { summary: { skipped: true, reason: 'db_error' } };
    }

    ctx.log('debug', 'Task counts', counts);

    const atCapacity = counts.inProgress >= ctx.cfg.maxWorkers;
    let spawned = 0;

    // ------------------------------------------------------------------
    // 2. Fill available worker slots (skip when at capacity or rate-limited)
    // ------------------------------------------------------------------
    if (atCapacity) {
      ctx.setPhase('waiting');
      ctx.log('info', `At capacity: ${counts.inProgress}/${ctx.cfg.maxWorkers} workers in progress`);
    } else if (this.isRateLimited(ctx)) {
      // Rate-limit hold-off active — don't spawn
    } else {
      const slots = ctx.cfg.maxWorkers - counts.inProgress;
      ctx.setPhase('spawning');

      const refinersAlreadyRunning = ctx.state.activeWorkers.filter(
        (w) => w.role === 'refiner' && isAlive(w.pid),
      ).length;

      const refinerState: RefinerState = {
        cap: Math.max(1, Math.floor(ctx.cfg.maxWorkers * REFINER_MAX_FRACTION)),
        floor: Math.max(1, Math.ceil(ctx.cfg.maxWorkers * REFINER_RESERVE_FRACTION)),
        alreadyRunning: refinersAlreadyRunning,
      };

      const roles = this.decideSpawns(slots, counts, refinerState, knownRoles);

      if (roles.length === 0) {
        ctx.state.lastNoWorkAt = new Date().toISOString();
        ctx.log('warn', 'No eligible tasks available — waiting for human input', counts);
        await fireAlert(
          ctx.cfg, ctx.state, ctx.log, 'task_exhaustion',
          'Task queue is empty — no draft or eligible tasks remain',
          counts as unknown as Record<string, unknown>,
        );
      } else {
        spawned = await this.executeSpawns(roles, ctx, counts);
      }
    }

    ctx.setPhase('idle');

    // ------------------------------------------------------------------
    // 3. Handle operator-initiated spawn requests — bypass maxWorkers cap
    // ------------------------------------------------------------------
    const pendingSpawnRequests =
      (ctx.shared[PENDING_SPAWN_REQUESTS_KEY] as SpawnRequestSignal[] | undefined) ?? [];

    let spawnRequestsHandled = 0;
    for (const req of pendingSpawnRequests) {
      const role = req.role ?? this.autoDetectRole(counts, knownRoles);
      if (!role) {
        ctx.log('warn', 'spawn_request: no eligible tasks to spawn for', {
          requested_by: req.requested_by,
          task_id: req.task_id,
        });
        continue;
      }
      ctx.log('info', 'spawn_request: spawning worker (operator override — bypassing maxWorkers cap)', {
        role,
        requested_by: req.requested_by,
        task_id: req.task_id ?? null,
      });
      try {
        const worker = await this.doSpawn(ctx, role, counts, req.task_id);
        if (worker) {
          ctx.state.stats.workersSpawned++;
          spawnRequestsHandled++;
          counts.inProgress++;
          if (role === 'refiner') {
            counts.draft = Math.max(0, counts.draft - 1);
          } else {
            counts.eligible = Math.max(0, counts.eligible - 1);
            const roleKey = role === 'implementer' ? '' : role;
            if (counts.eligibleByRole[roleKey] !== undefined) {
              counts.eligibleByRole[roleKey] = Math.max(0, counts.eligibleByRole[roleKey] - 1);
            }
          }
        }
      } catch (err) {
        ctx.log('error', `spawn_request: failed to spawn ${role} worker`, { error: String(err) });
      }
    }

    return {
      summary: { spawned, spawnRequestsHandled },
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private isRateLimited(ctx: TickContext): boolean {
    if (!ctx.state.rateLimitedUntil) return false;

    const holdUntil = new Date(ctx.state.rateLimitedUntil).getTime();
    if (Date.now() < holdUntil) {
      const resumeAt = new Date(ctx.state.rateLimitedUntil).toLocaleTimeString();
      ctx.log('info', `Spawning suppressed — rate limited until ${resumeAt}`);
      ctx.setPhase('waiting');
      return true;
    }

    // Hold-off has expired — clear it.
    ctx.state.rateLimitedUntil = null;
    return false;
  }

  private async loadKnownRoles(workDir: string): Promise<Set<string>> {
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const raw = await readFile(join(workDir, 'roles.json'), 'utf8');
      const config = JSON.parse(raw) as { roles: Array<{ id: string }> };
      return new Set(config.roles.map((r) => r.id));
    } catch {
      return new Set(['implementer', 'refiner', 'planner', 'tq-reader', 'tq-writer']);
    }
  }

  /**
   * Pure function: decide the ordered list of roles to spawn for available slots.
   */
  private decideSpawns(
    slots: number,
    counts: TaskCounts,
    refinerState: RefinerState,
    knownRoles: Set<string>,
  ): string[] {
    // Work on a shallow copy so simulated count decrements don't mutate the caller's object.
    const c: TaskCounts = {
      ...counts,
      eligibleByRole: { ...counts.eligibleByRole },
    };

    const roles: string[] = [];
    let refinersThisTick = 0;

    for (let i = 0; i < slots; i++) {
      const action = this.decideNextAction(
        c,
        refinerState.alreadyRunning + refinersThisTick,
        refinerState.cap,
        refinerState.floor,
        knownRoles,
      );

      if (!action) break;

      roles.push(action);

      // Optimistically update simulated counts
      c.inProgress++;
      if (action === 'refiner') {
        refinersThisTick++;
        c.draft = Math.max(0, c.draft - 1);
      } else {
        c.eligible = Math.max(0, c.eligible - 1);
        const roleKey = action === 'implementer' ? '' : action;
        if (c.eligibleByRole[roleKey] !== undefined) {
          c.eligibleByRole[roleKey] = Math.max(0, c.eligibleByRole[roleKey] - 1);
        }
      }
    }

    return roles;
  }

  private decideNextAction(
    counts: TaskCounts,
    refinerCount: number,
    refinerCap: number,
    refinerFloor: number,
    knownRoles: Set<string>,
  ): string | null {
    const canRefine = counts.draft > 0 && refinerCount < refinerCap;

    const spawnableRoles: Array<{ spawnRole: string; count: number }> = [];
    for (const [assignedRole, count] of Object.entries(counts.eligibleByRole)) {
      if (count <= 0) continue;
      if (assignedRole === '') {
        const implementable = Math.max(0, count - counts.eligibleBlockedByChildren);
        if (implementable > 0) {
          spawnableRoles.push({ spawnRole: 'implementer', count: implementable });
        }
      } else if (knownRoles.has(assignedRole)) {
        spawnableRoles.push({ spawnRole: assignedRole, count });
      }
    }

    const hasEligibleWork = spawnableRoles.length > 0;

    if (canRefine && refinerCount < refinerFloor) return 'refiner';

    if (canRefine && hasEligibleWork) {
      return counts.maxDraftPriority >= counts.maxEligiblePriority
        ? 'refiner'
        : spawnableRoles[0].spawnRole;
    }

    if (hasEligibleWork) return spawnableRoles[0].spawnRole;
    if (canRefine) return 'refiner';

    return null;
  }

  private autoDetectRole(counts: TaskCounts, knownRoles: Set<string>): string | null {
    const spawnableRoles: Array<{ spawnRole: string; count: number }> = [];
    for (const [assignedRole, count] of Object.entries(counts.eligibleByRole)) {
      if (count <= 0) continue;
      if (assignedRole === '') {
        const implementable = Math.max(0, count - counts.eligibleBlockedByChildren);
        if (implementable > 0) spawnableRoles.push({ spawnRole: 'implementer', count: implementable });
      } else if (knownRoles.has(assignedRole)) {
        spawnableRoles.push({ spawnRole: assignedRole, count });
      }
    }

    const hasEligibleWork = spawnableRoles.length > 0;

    if (hasEligibleWork && counts.draft > 0) {
      return counts.maxDraftPriority >= counts.maxEligiblePriority
        ? 'refiner'
        : spawnableRoles[0].spawnRole;
    }
    if (hasEligibleWork) return spawnableRoles[0].spawnRole;
    if (counts.draft > 0) return 'refiner';
    return null;
  }

  private async executeSpawns(
    roles: string[],
    ctx: TickContext,
    counts: TaskCounts,
  ): Promise<number> {
    let spawned = 0;
    for (const action of roles) {
      try {
        const worker = await this.doSpawn(ctx, action, counts);
        if (worker) {
          ctx.state.stats.workersSpawned++;
          spawned++;
          counts.inProgress++;
          if (action === 'refiner') {
            counts.draft = Math.max(0, counts.draft - 1);
          } else {
            counts.eligible = Math.max(0, counts.eligible - 1);
            const roleKey = action === 'implementer' ? '' : action;
            if (counts.eligibleByRole[roleKey] !== undefined) {
              counts.eligibleByRole[roleKey] = Math.max(0, counts.eligibleByRole[roleKey] - 1);
            }
          }
        }
      } catch (err) {
        ctx.log('error', `Failed to spawn ${action} worker`, { error: String(err) });
      }
    }
    return spawned;
  }

  private async doSpawn(
    ctx: TickContext,
    action: string,
    _counts: TaskCounts,
    taskId?: string,
  ): Promise<SpawnedWorker | null> {
    const spawned = spawnWorker(ctx.cfg.workDir, action, taskId);
    ctx.log('info', `Spawned ${action} worker`, { pid: spawned.pid, taskId: taskId ?? null });

    if (spawned.pid < 0) {
      ctx.log('warn', `Failed to get PID for ${action} worker`);
      return null;
    }

    // Track the worker in state (best-effort; the real truth is the DB)
    ctx.state.activeWorkers = [
      ...ctx.state.activeWorkers.filter((w) => isAlive(w.pid)),
      spawned,
    ];

    return spawned;
  }
}
