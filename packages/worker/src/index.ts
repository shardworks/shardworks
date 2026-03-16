#!/usr/bin/env node
import { program, configFromParsedOpts } from './config.js';
import { loadRole } from './roles.js';
import { claimTask, claimTaskById, releaseTask } from './claim.js';
import { launch } from './launcher.js';
import { mergeWorktreeToMain } from './merge.js';
import type { ConductedConfig } from './config.js';
import type { LaunchResult } from './launcher.js';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/** sysexits.h EX_TEMPFAIL — temporary failure, retry later */
const EX_TEMPFAIL = 75;

// ---------------------------------------------------------------------------
// Conductor signal file
// ---------------------------------------------------------------------------

/**
 * Append a structured signal event to data/conductor-signals.jsonl so the
 * conductor can react on its next tick (e.g. fire a webhook, create a
 * sentinel task).  Uses synchronous I/O so it is safe to call before exit.
 */
function appendConductorSignal(workDir: string, signal: Record<string, unknown>): void {
  try {
    const dir = join(workDir, 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, 'conductor-signals.jsonl');
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...signal }) + '\n');
  } catch {
    // Non-fatal — conductor will pick up the situation on the next tick via DB
  }
}

// ---------------------------------------------------------------------------
// Structured exit status (written to stderr before exit)
// ---------------------------------------------------------------------------

interface ExitStatus {
  status: 'completed' | 'failed' | 'rate_limited' | 'crashed';
  task_id: string;
  agent_id: string;
  session_id: string | null;
  cost_usd: number;
  commit_sha?: string;
  retry_after?: string | null;
  error?: string;
}

function writeExitStatus(status: ExitStatus): void {
  process.stderr.write('\n' + JSON.stringify(status) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await program.parseAsync();
  const config = configFromParsedOpts();

  // Validate and load the role definition early so misconfiguration fails fast.
  const role = loadRole(config.role, config.workDir);

  let conducted: ConductedConfig;

  if (config.mode === 'conducted') {
    // Conducted mode: claim the specific task by ID with our ephemeral agent ID
    await claimTaskById(config.agentId, config.workDir, config.taskId, role.claimDraft);
    conducted = config;
  } else {
    // One-shot: atomically claim the next suitable task before spawning Claude
    const taskId = await claimTask(config.agentId, config.workDir, role.claimDraft, role.id);
    if (taskId === null) {
      const pool = role.claimDraft ? 'draft' : 'eligible';
      process.stderr.write(`worker: no ${pool} tasks for role "${role.id}" (agent: ${config.agentId})\n`);
      process.exit(0);
    }
    conducted = { ...config, mode: 'conducted', taskId };
  }

  const handle = launch(conducted);

  // Wait for Claude to establish a session, then emit metadata for the orchestrator.
  const meta = await handle.metadata;
  process.stdout.write(JSON.stringify(meta) + '\n');

  // Signal to the orchestrator that all metadata has been emitted and it can detach.
  await new Promise<void>(resolve => process.stdout.end(resolve));

  // Now run until Claude finishes.
  const launchResult: LaunchResult = await handle.done;

  // Rate-limit detection: release the task and exit EX_TEMPFAIL
  if (launchResult.result?.isRateLimit) {
    // Notify the conductor immediately via the shared signal file
    appendConductorSignal(conducted.workDir, {
      type: 'rate_limited',
      task_id: conducted.taskId,
      agent_id: conducted.agentId,
      session_id: launchResult.sessionId,
      retry_after: launchResult.result.retryAfter,
      cost_usd: launchResult.result.costUsd,
    });

    try {
      await releaseTask(conducted.agentId, conducted.workDir, conducted.taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`worker: failed to release task: ${msg}\n`);
    }

    writeExitStatus({
      status: 'rate_limited',
      task_id: conducted.taskId,
      agent_id: conducted.agentId,
      session_id: launchResult.sessionId,
      cost_usd: launchResult.result.costUsd,
      retry_after: launchResult.result.retryAfter,
    });

    process.exit(EX_TEMPFAIL);
  }

  // Normal exit: determine status from result info and exit code
  if (launchResult.exitCode === 0) {
    const isAgentError = launchResult.result?.isError ?? false;

    // On successful completion (not an agent-reported error), merge the
    // worktree branch back into main and push.  Refiners and planners that
    // made no code changes will get a fast no-op (no-branch or no-commits).
    let commitSha: string | undefined;
    if (!isAgentError) {
      const merge = await mergeWorktreeToMain(conducted.taskId, conducted.workDir);
      if (merge.ok) {
        commitSha = merge.commitSha;
        if (merge.reason === 'merged') {
          process.stderr.write(`worker: merged worktree to main (${commitSha})\n`);
        }
      } else {
        process.stderr.write(`worker: merge failed [${merge.reason}]: ${merge.msg}\n`);
        appendConductorSignal(conducted.workDir, {
          type: 'merge_failed',
          task_id: conducted.taskId,
          agent_id: conducted.agentId,
          reason: merge.reason,
          msg: merge.msg,
        });
      }
    }

    writeExitStatus({
      status: isAgentError ? 'failed' : 'completed',
      task_id: conducted.taskId,
      agent_id: conducted.agentId,
      session_id: launchResult.sessionId,
      cost_usd: launchResult.result?.costUsd ?? 0,
      ...(commitSha ? { commit_sha: commitSha } : {}),
    });
  } else {
    // Claude crashed without updating task state — release it back to eligible
    // so another worker can pick it up, rather than leaving it stuck in_progress.
    appendConductorSignal(conducted.workDir, {
      type: 'crashed',
      task_id: conducted.taskId,
      agent_id: conducted.agentId,
      session_id: launchResult.sessionId,
      exit_code: launchResult.exitCode,
      cost_usd: launchResult.result?.costUsd ?? 0,
    });

    try {
      await releaseTask(conducted.agentId, conducted.workDir, conducted.taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`worker: failed to release task after crash: ${msg}\n`);
    }

    writeExitStatus({
      status: 'crashed',
      task_id: conducted.taskId,
      agent_id: conducted.agentId,
      session_id: launchResult.sessionId,
      cost_usd: launchResult.result?.costUsd ?? 0,
      error: `claude exited with code ${launchResult.exitCode}`,
    });
  }

  process.exit(launchResult.exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`worker: ${message}\n`);
  process.exit(1);
});

