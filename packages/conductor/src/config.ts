// ---------------------------------------------------------------------------
// Conductor configuration
// ---------------------------------------------------------------------------

export interface ConductorConfig {
  /** Working directory — all data paths are relative to this. */
  workDir: string;
  /** Maximum number of concurrent worker processes (N). */
  maxWorkers: number;
  /** How long to sleep between ticks, in milliseconds. */
  pollIntervalMs: number;
  /** Stale-task threshold passed to `tq reap` (e.g. "30m"). */
  staleAfter: string;
  /**
   * Optional webhook URL for urgent alerts (rate limits, task exhaustion).
   * Payload is Slack-compatible JSON. Works with Slack, Discord, ntfy.sh, etc.
   */
  alertWebhook: string | null;
}

export function loadConfig(overrides: Partial<ConductorConfig> = {}): ConductorConfig {
  return {
    workDir: overrides.workDir
      ?? process.env['WORK_DIR']
      ?? process.cwd(),
    maxWorkers: overrides.maxWorkers
      ?? parseInt(process.env['CONDUCTOR_MAX_WORKERS'] ?? '3', 10),
    pollIntervalMs: overrides.pollIntervalMs
      ?? parseInt(process.env['CONDUCTOR_POLL_INTERVAL'] ?? '30', 10) * 1000,
    staleAfter: overrides.staleAfter
      ?? process.env['CONDUCTOR_STALE_AFTER']
      ?? '30m',
    alertWebhook: overrides.alertWebhook
      ?? process.env['CONDUCTOR_ALERT_WEBHOOK']
      ?? null,
  };
}
