#!/usr/bin/env node
import { parseConfig } from './config.js';
import { loadRole } from './roles.js';
import { claimTask } from './claim.js';
import { launch } from './launcher.js';
import type { ConductedConfig } from './config.js';

async function main(): Promise<void> {
  const config = parseConfig();

  // Validate and load the role definition early so misconfiguration fails fast.
  const role = loadRole(config.role, config.workDir);

  let conducted: ConductedConfig;

  if (config.mode === 'conducted') {
    conducted = config;
  } else if (role.claimDraft === null) {
    // Planner mode: no task to claim — work on the whole backlog.
    // Use a synthetic task ID so the launch pipeline has something to reference.
    conducted = { ...config, mode: 'conducted', taskId: '__backlog__' };
  } else {
    // One-shot: atomically claim the next suitable task before spawning Claude
    const taskId = await claimTask(config.agentId, config.workDir, role.claimDraft);
    if (taskId === null) {
      // Nothing available for this role — exit cleanly so a supervisor can sleep and retry
      const pool = role.claimDraft ? 'draft' : 'eligible';
      process.stderr.write(`worker: no ${pool} tasks (role: ${role.id})\n`);
      process.exit(0);
    }
    conducted = { ...config, mode: 'conducted', taskId };
  }

  const { exitCode, sessionId } = await launch(conducted);

  // Print session ID to stdout so the caller (conductor/supervisor) can store it
  // for use as --resume-session on subsequent invocations.
  if (sessionId) {
    process.stdout.write(sessionId + '\n');
  }

  process.exit(exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`worker: ${message}\n`);
  process.exit(1);
});
