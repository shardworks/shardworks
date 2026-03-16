import type { ConductorConfig } from './config.js';
import type { ConductorState, AlertType, LogFn } from './state.js';
import { runTq } from './spawn.js';
import type { WorkerSignal } from './signals.js';

// ---------------------------------------------------------------------------
// Alert payload
// ---------------------------------------------------------------------------

export interface AlertPayload {
  type: AlertType;
  msg: string;
  details?: Record<string, unknown>;
  ts: string;
}

// ---------------------------------------------------------------------------
// Cooldown: don't spam the same alert type repeatedly
// ---------------------------------------------------------------------------

/** Minimum milliseconds between repeated alerts of the same type. */
const ALERT_COOLDOWN_MS: Record<AlertType, number> = {
  rate_limited:    5 * 60 * 1000,   //  5 min  — urgent but can repeat
  task_exhaustion: 60 * 60 * 1000,  // 60 min  — back off if queue stays dry
  crashed:         10 * 60 * 1000,  // 10 min
  merge_failed:    10 * 60 * 1000,  // 10 min
};

function isCooledDown(state: ConductorState, type: AlertType): boolean {
  const last = state.lastAlertAt[type];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > ALERT_COOLDOWN_MS[type];
}

function markAlerted(state: ConductorState, type: AlertType): void {
  state.lastAlertAt[type] = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * POST a Slack-compatible webhook payload.
 * Works with Slack, Discord (/slack endpoint), ntfy.sh, and any generic
 * JSON webhook receiver.
 */
async function postWebhook(url: string, payload: AlertPayload): Promise<void> {
  const icon = payload.type === 'task_exhaustion' ? '🕳️' : '⚠️';
  const body = JSON.stringify({
    text: `${icon} *Shardworks conductor — ${payload.type.replace('_', ' ')}*`,
    attachments: [
      {
        color: payload.type === 'task_exhaustion' ? '#888888' : '#FF0000',
        fields: [
          { title: 'Message', value: payload.msg, short: false },
          ...Object.entries(payload.details ?? {}).map(([k, v]) => ({
            title: k,
            value: String(v),
            short: true,
          })),
          { title: 'Time', value: new Date(payload.ts).toLocaleString(), short: true },
        ],
      },
    ],
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Webhook returned ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Sentinel task
// ---------------------------------------------------------------------------

/**
 * Enqueue a high-priority sentinel task with assigned_role=human so it
 * shows up visibly in the dashboard and task list.  No worker will claim it —
 * a human must manually cancel it when the issue is resolved.
 */
async function createSentinelTask(
  workDir: string,
  type: AlertType,
  msg: string,
): Promise<string | null> {
  try {
    const description = `⚠ Human attention needed [${type}]: ${msg}`;
    const result = await runTq<{ id: string }>(workDir, [
      'enqueue', description,
      '--assigned-role', 'human',
      '--priority', '999',
      '--ready',
    ]);
    return result.id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Fire an alert if it's not still in cooldown.
 * Sends a webhook (if configured) and creates a sentinel task in the queue.
 */
export async function fireAlert(
  cfg: ConductorConfig,
  state: ConductorState,
  log: LogFn,
  type: AlertType,
  msg: string,
  details?: Record<string, unknown>,
): Promise<void> {
  if (!isCooledDown(state, type)) {
    log('debug', `Alert "${type}" suppressed (still in cooldown)`);
    return;
  }

  markAlerted(state, type);

  const payload: AlertPayload = { type, msg, details, ts: new Date().toISOString() };

  log('warn', `ALERT [${type}]: ${msg}`, details);

  // 1. Webhook
  if (cfg.alertWebhook) {
    try {
      await postWebhook(cfg.alertWebhook, payload);
      log('info', 'Alert webhook delivered', { type });
    } catch (err) {
      log('error', 'Alert webhook failed', { type, error: String(err) });
    }
  }

  // 2. Sentinel task in the queue
  const taskId = await createSentinelTask(cfg.workDir, type, msg);
  if (taskId) {
    log('info', 'Created sentinel task', { type, taskId });
  }
}

// ---------------------------------------------------------------------------
// Convenience: process a batch of worker signals into alerts
// ---------------------------------------------------------------------------

export async function processSignals(
  cfg: ConductorConfig,
  state: ConductorState,
  log: LogFn,
  signals: WorkerSignal[],
): Promise<void> {
  for (const signal of signals) {
    if (signal.type === 'rate_limited') {
      await fireAlert(cfg, state, log, 'rate_limited',
        `Worker hit rate limit on task ${signal.task_id}`,
        {
          task_id: signal.task_id,
          agent_id: signal.agent_id,
          retry_after: signal.retry_after ?? 'unknown',
          cost_usd: signal.cost_usd,
        },
      );
    } else if (signal.type === 'crashed') {
      await fireAlert(cfg, state, log, 'crashed',
        `Worker crashed on task ${signal.task_id} (exit ${signal.exit_code})`,
        {
          task_id: signal.task_id,
          agent_id: signal.agent_id,
          exit_code: signal.exit_code,
        },
      );
    } else if (signal.type === 'merge_failed') {
      await fireAlert(cfg, state, log, 'merge_failed',
        `Worktree merge failed for task ${signal.task_id} [${signal.reason}]: ${signal.msg}`,
        {
          task_id: signal.task_id,
          agent_id: signal.agent_id,
          reason: signal.reason,
        },
      );
    }
  }
}
