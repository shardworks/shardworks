import type { Manager, ManagerResult, TickContext } from './manager.js';
import { reapStale } from '../spawn.js';

// ---------------------------------------------------------------------------
// ReaperManager
// ---------------------------------------------------------------------------

/**
 * Find and release stale in_progress tasks whose workers have died.
 *
 * Responsibilities:
 *   - Call `tq reap --stale-after <duration> --release` to find tasks that
 *     have been in_progress longer than the configured threshold without
 *     a heartbeat.
 *   - Update stats with the number of reaped tasks.
 *   - Non-fatal: if the reap call fails, log a warning and continue.
 */
export class ReaperManager implements Manager {
  readonly name = 'reaper';

  async run(ctx: TickContext): Promise<ManagerResult> {
    ctx.setPhase('reaping');

    let reaped = 0;
    try {
      const reapResult = await reapStale(ctx.cfg.workDir, ctx.cfg.staleAfter);
      if (reapResult.released.length > 0) {
        reaped = reapResult.released.length;
        ctx.state.stats.tasksReaped += reaped;
        ctx.log('info', `Reaped ${reaped} stale task(s)`, {
          ids: reapResult.released.map((t) => t.id),
        });
      }
    } catch (err) {
      ctx.log('warn', 'Reap failed, continuing', { error: String(err) });
    }

    return { summary: { reaped } };
  }
}
