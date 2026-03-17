// ---------------------------------------------------------------------------
// Manager modules — re-exported for convenience
// ---------------------------------------------------------------------------

export type { Manager, ManagerResult, TickContext } from './manager.js';

export { SignalDrainManager } from './signal-drain.js';
export { ReaperManager } from './reaper.js';
export { SpawnerManager } from './spawner.js';
export { JanitorManager } from './janitor.js';

// ---------------------------------------------------------------------------
// Default manager pipeline
// ---------------------------------------------------------------------------

import type { Manager } from './manager.js';
import { SignalDrainManager } from './signal-drain.js';
import { ReaperManager } from './reaper.js';
import { SpawnerManager } from './spawner.js';
import { JanitorManager } from './janitor.js';

/**
 * Create the default ordered list of managers for the conductor tick loop.
 *
 * Execution order matters:
 *   1. signal-drain — must run first to capture rate-limit / shutdown signals
 *   2. reaper       — release stale tasks before assessing capacity
 *   3. spawner      — fill slots and handle spawn requests
 *   4. janitor      — background cleanup (throttled, low priority)
 *
 * Managers are easily extensible: to add a new concern, implement the Manager
 * interface and insert it at the appropriate position in this pipeline.
 */
export function createDefaultManagers(): Manager[] {
  return [
    new SignalDrainManager(),
    new ReaperManager(),
    new SpawnerManager(),
    new JanitorManager(),
  ];
}
