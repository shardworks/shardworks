#!/usr/bin/env node
import { Command } from 'commander';
import { watch } from './watch.js';
import { dashboard } from './dashboard.js';
import { pool } from './db.js';

const program = new Command()
  .name('work')
  .description('Shardworks operator tool — monitoring & admin')
  .version('0.0.1');

// ── work watch ──────────────────────────────────────────────────────────────

program
  .command('watch <id>')
  .description('Tail a worker or task log in realtime (worker UUID or task ID)')
  .action(async (id: string) => {
    await watch(id);
  });

// ── work dashboard ──────────────────────────────────────────────────────────

program
  .command('dashboard')
  .alias('dash')
  .description('Full-screen terminal dashboard for fleet monitoring')
  .action(async () => {
    try {
      await dashboard();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Dashboard error: ${msg}\n`);
      await pool.end();
      process.exit(1);
    }
  });

program.parse();
