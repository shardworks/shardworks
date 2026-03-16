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
  // Closing stdout causes any pipe reader (the orchestrator) to get EOF.
  // In interactive mode we keep stderr open for formatted output, but stdout is done.
  // Use end() + destroy() to fully close the fd so the orchestrator sees EOF even
  // if it hasn't closed its end of the pipe yet.
  await new Promise<void>(resolve => process.stdout.end(resolve));

  // Now run until Claude finishes. In interactive mode, formatted output continues
  // on stderr. In non-interactive mode, the process is silent — only the log file
  // captures output.
  const { exitCode } = await handle.done;
  process.exit(exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`worker: ${message}\n`);
  process.exit(1);
});
