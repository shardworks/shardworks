import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  readPid,
  writePid,
  clearPid,
  isAlive,
  readState,
  logPath,
  type LogEntry,
} from './state.js';
import { loadConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the conductor bin script relative to this file (works for both src/ and dist/). */
function conductorBin(): string {
  return resolve(__dirname, '..', 'bin', 'conductor');
}

function workDirFromEnvOrCwd(): string {
  return process.env['WORK_DIR'] ?? process.cwd();
}

function formatLogEntry(entry: LogEntry): string {
  const levelColors: Record<string, string> = {
    info:  '\x1b[32m',  // green
    warn:  '\x1b[33m',  // yellow
    error: '\x1b[31m',  // red
    debug: '\x1b[90m',  // grey
  };
  const reset = '\x1b[0m';
  const dim   = '\x1b[2m';

  const color = levelColors[entry.level] ?? '';
  const ts    = new Date(entry.ts).toLocaleTimeString();
  const phase = `[${entry.phase}]`.padEnd(12);
  const data  = entry.data !== undefined ? `  ${dim}${JSON.stringify(entry.data)}${reset}` : '';

  return `${dim}${ts}${reset} ${color}${entry.level.toUpperCase().padEnd(5)}${reset} ${dim}${phase}${reset} ${entry.msg}${data}`;
}

// ---------------------------------------------------------------------------
// CLI program
// ---------------------------------------------------------------------------

const program = new Command()
  .name('conductor')
  .description('Shardworks conductor — orchestrate the worker fleet')
  .version('0.0.1');

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

program
  .command('start')
  .description('Start the conductor daemon in the background')
  .option('-n, --max-workers <n>', 'Maximum concurrent workers', '3')
  .option('-x, --batch-plan-threshold <n>', 'Tasks since last plan before triggering full-backlog planning', '20')
  .option('--poll-interval <seconds>', 'Seconds between ticks', '30')
  .option('--stale-after <duration>', 'Reap tasks stale longer than this (e.g. 30m)', '30m')
  .option('--alert-webhook <url>', 'Webhook URL for urgent alerts (Slack/Discord/ntfy.sh/etc.)')
  .option('--workdir <path>', 'Working directory (default: $WORK_DIR or cwd)')
  .action(async (opts: {
    maxWorkers: string;
    batchPlanThreshold: string;
    pollInterval: string;
    staleAfter: string;
    alertWebhook?: string;
    workdir?: string;
  }) => {
    const workDir = opts.workdir ?? workDirFromEnvOrCwd();

    // Check if already running
    const existingPid = await readPid(workDir);
    if (existingPid !== null && isAlive(existingPid)) {
      console.error(`Conductor is already running (PID ${existingPid}). Use 'conductor stop' first.`);
      process.exit(1);
    }

    // Spawn the daemon as a fully detached background process
    const child = spawn(conductorBin(), ['_daemon'], {
      cwd: workDir,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WORK_DIR: workDir,
        CONDUCTOR_MAX_WORKERS: opts.maxWorkers,
        CONDUCTOR_BATCH_PLAN_THRESHOLD: opts.batchPlanThreshold,
        CONDUCTOR_POLL_INTERVAL: opts.pollInterval,
        CONDUCTOR_STALE_AFTER: opts.staleAfter,
        ...(opts.alertWebhook ? { CONDUCTOR_ALERT_WEBHOOK: opts.alertWebhook } : {}),
      },
    });

    child.unref();

    const pid = child.pid;
    if (!pid) {
      console.error('Failed to spawn conductor daemon (no PID assigned).');
      process.exit(1);
    }

    await writePid(workDir, pid);

    console.log(`Conductor started (PID ${pid}).`);
    console.log(`  Logs:   conductor logs`);
    console.log(`  Status: conductor status`);
  });

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

program
  .command('stop')
  .description('Stop the conductor daemon')
  .option('--workdir <path>', 'Working directory (default: $WORK_DIR or cwd)')
  .option('--timeout <seconds>', 'Seconds to wait for graceful shutdown', '10')
  .action(async (opts: { workdir?: string; timeout: string }) => {
    const workDir  = opts.workdir ?? workDirFromEnvOrCwd();
    const timeoutMs = parseInt(opts.timeout, 10) * 1000;

    const pid = await readPid(workDir);
    if (pid === null) {
      console.error('No conductor PID file found — is the conductor running?');
      process.exit(1);
    }

    if (!isAlive(pid)) {
      console.log(`Conductor (PID ${pid}) is not running. Cleaning up PID file.`);
      await clearPid(workDir);
      return;
    }

    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to conductor (PID ${pid})...`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(200);
      if (!isAlive(pid)) {
        console.log('Conductor stopped.');
        await clearPid(workDir);
        return;
      }
    }

    // Force kill
    try {
      process.kill(pid, 'SIGKILL');
      console.log(`Conductor did not exit after ${opts.timeout}s — sent SIGKILL.`);
    } catch {
      // Process may have just exited between checks
    }
    await clearPid(workDir);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show conductor status and fleet overview')
  .option('--workdir <path>', 'Working directory (default: $WORK_DIR or cwd)')
  .action(async (opts: { workdir?: string }) => {
    const workDir = opts.workdir ?? workDirFromEnvOrCwd();

    const pid    = await readPid(workDir);
    const alive  = pid !== null && isAlive(pid);
    const state  = await readState(workDir);

    const status = alive ? '\x1b[32m● running\x1b[0m' : '\x1b[31m○ stopped\x1b[0m';

    console.log(`Conductor: ${status}${pid ? `  (PID ${pid})` : ''}`);
    console.log();

    if (state) {
      const up = state.stats.startedAt
        ? `up since ${new Date(state.stats.startedAt).toLocaleString()}`
        : '';
      console.log(`  Phase:        ${state.phase}${up ? `  (${up})` : ''}`);
      console.log(`  Last tick:    ${state.lastTickAt ? new Date(state.lastTickAt).toLocaleString() : 'never'}`);
      console.log(`  Last plan:    ${state.lastFullPlanAt ? new Date(state.lastFullPlanAt).toLocaleString() : 'never'}`);
      console.log();
      console.log('  Stats:');
      console.log(`    Ticks run:       ${state.stats.tickCount}`);
      console.log(`    Workers spawned: ${state.stats.workersSpawned}`);
      console.log(`    Tasks reaped:    ${state.stats.tasksReaped}`);
      console.log(`    Full plans run:  ${state.stats.fullPlansRun}`);

      if (state.activeWorkers.length > 0) {
        console.log();
        console.log('  Active workers (last seen):');
        for (const w of state.activeWorkers) {
          const workerAlive = isAlive(w.pid);
          const icon = workerAlive ? '↑' : '↓';
          const elapsed = w.startedAt
            ? formatElapsed(Date.now() - new Date(w.startedAt).getTime())
            : '';
          console.log(
            `    ${icon} PID ${String(w.pid).padEnd(7)} role=${w.role.padEnd(12)} task=${w.taskId ?? '(claiming)'}  ${elapsed}`,
          );
        }
      }

      if (state.lastNoWorkAt) {
        console.log();
        console.log(`  \x1b[33m⚠ Last "no work" at ${new Date(state.lastNoWorkAt).toLocaleString()} — human input may be needed\x1b[0m`);
      }
    } else if (!alive) {
      console.log('  No state file found.');
    }
  });

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

program
  .command('logs')
  .description('Tail conductor activity logs')
  .option('--workdir <path>', 'Working directory (default: $WORK_DIR or cwd)')
  .option('-n, --lines <n>', 'Show last N lines on startup (0 = follow from tail)', '20')
  .option('--no-follow', 'Print existing log and exit (do not follow)')
  .action(async (opts: { workdir?: string; lines: string; follow: boolean }) => {
    const workDir = opts.workdir ?? workDirFromEnvOrCwd();
    const logFile  = logPath(workDir);
    const tailLines = parseInt(opts.lines, 10);

    // Read existing content
    let existingLines: string[] = [];
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(logFile, 'utf8');
      existingLines = raw.split('\n').filter(Boolean);
    } catch {
      if (!opts.follow) {
        console.error(`Log file not found: ${logFile}`);
        process.exit(1);
      }
    }

    // Print last N lines
    const toShow = tailLines > 0
      ? existingLines.slice(-tailLines)
      : existingLines;

    for (const line of toShow) {
      printLogLine(line);
    }

    if (!opts.follow) return;

    // Follow mode: watch for new lines
    let fileSize = existingLines.join('\n').length + (existingLines.length > 0 ? existingLines.length : 0);
    try {
      const s = await stat(logFile);
      fileSize = s.size;
    } catch {
      fileSize = 0;
    }

    console.error('\x1b[2m(watching for new log entries…)\x1b[0m');

    // Poll the file for new content (simple and reliable across platforms)
    let currentSize = fileSize;
    let buffer = '';

    const poll = async (): Promise<void> => {
      try {
        const s = await stat(logFile);
        if (s.size > currentSize) {
          // Read the new bytes
          const stream = createReadStream(logFile, {
            start: currentSize,
            end: s.size - 1,
          });
          for await (const chunk of stream) {
            buffer += (chunk as Buffer).toString('utf8');
          }
          currentSize = s.size;

          // Process complete lines
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';  // keep incomplete last line
          for (const line of lines) {
            if (line.trim()) printLogLine(line);
          }
        }
      } catch {
        // File may not exist yet; keep polling
      }
    };

    // Poll every 500ms
    const interval = setInterval(() => { void poll(); }, 500);

    process.on('SIGINT', () => {
      clearInterval(interval);
      process.exit(0);
    });

    // Keep the process alive
    await new Promise<never>(() => undefined);
  });

// ---------------------------------------------------------------------------
// _daemon (hidden — invoked by `conductor start` as a detached subprocess)
// ---------------------------------------------------------------------------

program
  .command('_daemon')
  .description('Run the conductor daemon loop (internal use)')
  .addHelpText('before', 'This command is for internal use. Use `conductor start` instead.')
  .action(async () => {
    const { runDaemon } = await import('./daemon.js');
    const cfg = loadConfig();
    await runDaemon(cfg);
  });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function printLogLine(line: string): void {
  try {
    const entry = JSON.parse(line) as LogEntry;
    console.log(formatLogEntry(entry));
  } catch {
    console.log(line);
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

await program.parseAsync(process.argv);
