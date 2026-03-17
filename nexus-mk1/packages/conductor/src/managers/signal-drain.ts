import type { Manager, ManagerResult, TickContext } from './manager.js';
import { readNewSignals, type SpawnRequestSignal } from '../signals.js';
import { processSignals } from '../alerts.js';

// ---------------------------------------------------------------------------
// Shared-data key used to pass pending spawn requests to the spawner manager
// ---------------------------------------------------------------------------

export const PENDING_SPAWN_REQUESTS_KEY = 'pendingSpawnRequests';

// ---------------------------------------------------------------------------
// SignalDrainManager
// ---------------------------------------------------------------------------

/**
 * Drains the conductor signal file each tick.
 *
 * Responsibilities:
 *   - Read new lines from data/conductor-signals.jsonl since the last offset.
 *   - Separate spawn_request signals (forwarded to the spawner via shared context)
 *     from operational signals (rate_limited, crashed, merge_failed).
 *   - Process operational signals into alerts.
 *   - If a rate_limited signal is received, abort the tick early so the spawner
 *     does not launch new workers this tick (rateLimitedUntil suppresses subsequent ticks).
 */
export class SignalDrainManager implements Manager {
  readonly name = 'signal-drain';

  async run(ctx: TickContext): Promise<ManagerResult> {
    const pendingSpawnRequests: SpawnRequestSignal[] = [];

    try {
      const { signals, newOffset } = await readNewSignals(
        ctx.cfg.workDir,
        ctx.state.signalFileOffset,
      );
      ctx.state.signalFileOffset = newOffset;

      if (signals.length > 0) {
        ctx.log('info', `Processing ${signals.length} worker signal(s)`);

        const operationalSignals = signals.filter((s) => {
          if (s.type === 'spawn_request') {
            pendingSpawnRequests.push(s as SpawnRequestSignal);
            return false;
          }
          return true;
        });

        if (operationalSignals.length > 0) {
          const rateLimited = await processSignals(
            ctx.cfg,
            ctx.state,
            ctx.log,
            operationalSignals,
          );
          if (rateLimited) {
            ctx.log('warn', 'Rate limit signal received — pausing spawning until hold-off expires');
            return { abort: true };
          }
        }
      }
    } catch (err) {
      ctx.log('warn', 'Failed to read signal file', { error: String(err) });
    }

    // Pass spawn requests to the spawner manager via shared context
    ctx.shared[PENDING_SPAWN_REQUESTS_KEY] = pendingSpawnRequests;

    return {
      summary: { signalsProcessed: pendingSpawnRequests.length > 0 },
    };
  }
}
