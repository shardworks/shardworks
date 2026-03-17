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
  /**
   * Dolt branch all spawned workers operate on.
   * Defaults to 'main'. Workers are spawned with --branch <branch> and
   * DOLT_DATABASE is set to shardworks/<branch> in their environment so all
   * tq library calls and spawned CLI processes are branch-scoped automatically.
   */
  branch: string;
}

export function loadConfig(overrides: Partial<ConductorConfig> = {}): ConductorConfig {
  const maxWorkers = overrides.maxWorkers
    ?? parseInt(process.env['CONDUCTOR_MAX_WORKERS'] ?? '3', 10);
  if (!Number.isFinite(maxWorkers) || maxWorkers < 1) {
    throw new Error(
      `Invalid CONDUCTOR_MAX_WORKERS: "${process.env['CONDUCTOR_MAX_WORKERS']}". ` +
      `Must be an integer >= 1.`
    );
  }

  const pollIntervalMs = overrides.pollIntervalMs
    ?? parseInt(process.env['CONDUCTOR_POLL_INTERVAL'] ?? '30', 10) * 1000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      `Invalid CONDUCTOR_POLL_INTERVAL: "${process.env['CONDUCTOR_POLL_INTERVAL']}". ` +
      `Must be a positive integer (seconds).`
    );
  }

  const staleAfter = overrides.staleAfter
    ?? process.env['CONDUCTOR_STALE_AFTER']
    ?? '30m';
  if (!staleAfter || staleAfter.trim() === '') {
    throw new Error(
      `Invalid CONDUCTOR_STALE_AFTER: value must be a non-empty duration string (e.g. "30m").`
    );
  }

  return {
    workDir: overrides.workDir
      ?? process.env['WORK_DIR']
      ?? process.cwd(),
    maxWorkers,
    pollIntervalMs,
    staleAfter,
    alertWebhook: overrides.alertWebhook
      ?? process.env['CONDUCTOR_ALERT_WEBHOOK']
      ?? null,
    branch: overrides.branch
      ?? process.env['CONDUCTOR_BRANCH']
      ?? 'main',
  };
}
