#!/usr/bin/env node
import { parseConfig } from './config.js';
import { claimTask } from './claim.js';
import { launch } from './launcher.js';
import type { ConductedConfig } from './config.js';

async function main(): Promise<void> {
  const config = parseConfig();

  let conducted: ConductedConfig;

  if (config.mode === 'conducted') {
    conducted = config;
  } else {
    // One-shot: atomically claim the next eligible task before spawning Claude
    const taskId = await claimTask(config.agentId, config.workDir);
    if (taskId === null) {
      // Nothing eligible — exit cleanly so a supervisor can sleep and retry
      process.stderr.write('worker: no eligible tasks\n');
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
