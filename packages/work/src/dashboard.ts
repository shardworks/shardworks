import blessed from 'blessed';
import type { Widgets } from 'blessed';
import { pool } from './db.js';
import {
  workLogsDir,
  formatEvent,
  type StreamEvent,
} from './log.js';
import { createReadStream, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskRow extends RowDataPacket {
  id: string;
  description: string;
  status: string;
  parent_id: string | null;
  priority: number;
  claimed_by: string | null;
  claimed_at: Date | null;
  created_at: Date;
  assigned_role: string | null;
}

interface StatusCounts {
  pending: number;
  eligible: number;
  in_progress: number;
  completed: number;
  failed: number;
  draft: number;
  total: number;
}

interface ActiveWorker {
  agentId: string;
  taskId: string;
  description: string;
  claimedAt: Date | null;
  role: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function dashboard(): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Shardworks Dashboard',
    fullUnicode: true,
  });

  // ── Layout ──────────────────────────────────────────────────────────────

  // Left column (50%)
  const leftCol = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '50%',
    height: '100%',
  });

  // Right column (50%)
  const rightCol = blessed.box({
    parent: screen,
    top: 0,
    left: '50%',
    width: '50%',
    height: '100%',
  });

  // ── Fleet Status (top-left, 30%) ───────────────────────────────────────

  const fleetBox = blessed.box({
    parent: leftCol,
    top: 0,
    left: 0,
    width: '100%',
    height: '30%',
    label: ' Fleet Status ',
    border: { type: 'line' },
    style: {
      border: { fg: 'blue' },
      label: { fg: 'white', bold: true },
    },
    tags: true,
    padding: { left: 1, right: 1 },
  });

  // ── Active Workers (middle-left, 30%) ──────────────────────────────────

  const workersList = blessed.list({
    parent: leftCol,
    top: '30%',
    left: 0,
    width: '100%',
    height: '30%',
    label: ' Active Workers ',
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      selected: { bg: 'blue', fg: 'white' },
      item: { fg: 'white' },
    },
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    scrollable: true,
    padding: { left: 1, right: 1 },
  } as unknown as Widgets.ListOptions<Widgets.ListElementStyle>);

  // ── Worker Log (bottom-left, 40%) ──────────────────────────────────────

  const logBox = blessed.log({
    parent: leftCol,
    top: '60%',
    left: 0,
    width: '100%',
    height: '40%',
    label: ' Worker Log ',
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'white', bold: true },
    },
    tags: true,
    scrollable: true,
    scrollbar: { style: { bg: 'grey' } },
    mouse: true,
    padding: { left: 1, right: 1 },
  } as Widgets.LogOptions);

  // ── Pipeline (right column, full height) ───────────────────────────────

  const pipelineBox = blessed.list({
    parent: rightCol,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    label: ' Task Pipeline ',
    border: { type: 'line' },
    style: {
      border: { fg: 'magenta' },
      selected: { bg: 'blue', fg: 'white' },
      item: { fg: 'white' },
    },
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    scrollable: true,
    scrollbar: { style: { bg: 'grey' } },
    padding: { left: 1, right: 1 },
  } as unknown as Widgets.ListOptions<Widgets.ListElementStyle>);

  // ── Status bar ─────────────────────────────────────────────────────────

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    style: { bg: 'blue', fg: 'white' },
    tags: true,
    content: ' {bold}q{/bold} quit | {bold}↑↓{/bold} navigate workers | {bold}Enter{/bold} view logs | {bold}Tab{/bold} switch panel | {bold}r{/bold} refresh | {bold}h{/bold} toggle completed subtrees',
  });

  // ── State ──────────────────────────────────────────────────────────────

  let activeWorkers: ActiveWorker[] = [];
  let selectedWorkerIdx = 0;
  let currentLogWorkerId: string | null = null;
  let currentLogTaskId: string | null = null;
  let currentLogPath: string | null = null;
  let currentLogOffset = 0;
  let focusedPanel: 'workers' | 'pipeline' = 'workers';
  let hideCompletedSubtrees = true;

  // ── Data fetching ──────────────────────────────────────────────────────

  async function fetchStatusCounts(): Promise<StatusCounts> {
    try {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status`,
      );
      const counts: StatusCounts = {
        pending: 0, eligible: 0, in_progress: 0,
        completed: 0, failed: 0, draft: 0, total: 0,
      };
      for (const row of rows) {
        const s = row.status as string;
        const c = Number(row.cnt);
        if (s in counts) (counts as unknown as Record<string, number>)[s] = c;
        counts.total += c;
      }
      return counts;
    } catch {
      return { pending: 0, eligible: 0, in_progress: 0, completed: 0, failed: 0, draft: 0, total: 0 };
    }
  }

  /** Read the conductor state file and build a taskId→role map. */
  async function conductorRoleMap(): Promise<Map<string, string>> {
    const workDir = process.env['WORK_DIR'] ?? process.cwd();
    const statePath = join(workDir, 'data', 'conductor-state.json');
    try {
      const raw = await readFile(statePath, 'utf8');
      const state = JSON.parse(raw) as {
        activeWorkers?: Array<{ taskId: string | null; role: string }>;
      };
      const map = new Map<string, string>();
      for (const w of state.activeWorkers ?? []) {
        if (w.taskId) map.set(w.taskId, w.role);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  async function fetchActiveWorkers(): Promise<ActiveWorker[]> {
    try {
      const [rows] = await pool.execute<TaskRow[]>(
        `SELECT id, description, claimed_by, claimed_at, assigned_role FROM tasks
         WHERE status = 'in_progress' AND claimed_by IS NOT NULL
         ORDER BY claimed_at DESC`,
      );
      // Build conductor role map for tasks whose assigned_role is null
      const roleMap = await conductorRoleMap();
      return rows.map(r => ({
        agentId: r.claimed_by!,
        taskId: r.id,
        description: r.description,
        claimedAt: r.claimed_at,
        role: r.assigned_role ?? roleMap.get(r.id) ?? null,
      }));
    } catch {
      return [];
    }
  }

  interface TaskTreeResult {
    lines: string[];
    hiddenCount: number;
  }

  async function fetchTaskTree(): Promise<TaskTreeResult> {
    try {
      const [rows] = await pool.execute<TaskRow[]>(
        `SELECT id, description, status, parent_id, priority, assigned_role FROM tasks
         ORDER BY priority DESC, created_at ASC`,
      );

      // Build tree structure
      const byId = new Map(rows.map(r => [r.id, r]));
      const children = new Map<string | null, TaskRow[]>();
      for (const r of rows) {
        const pid = r.parent_id ?? null;
        if (!children.has(pid)) children.set(pid, []);
        children.get(pid)!.push(r);
      }

      // Check whether every node in a subtree is completed
      function isSubtreeCompleted(nodeId: string): boolean {
        const node = byId.get(nodeId);
        if (!node) return true;
        if (node.status !== 'completed') return false;
        const kids = children.get(nodeId) ?? [];
        return kids.every(k => isSubtreeCompleted(k.id));
      }

      const lines: string[] = [];
      function renderNode(node: TaskRow, indent: number): void {
        const prefix = indent === 0 ? '' : '  '.repeat(indent - 1) + '├─ ';
        const statusIcon = statusSymbol(node.status, node.assigned_role);
        const desc = node.description.length > 50
          ? node.description.slice(0, 47) + '...'
          : node.description;
        lines.push(`${prefix}${statusIcon} ${node.id} ${desc}`);
        const kids = children.get(node.id) ?? [];
        for (const kid of kids) {
          renderNode(kid, indent + 1);
        }
      }

      // Render root tasks (no parent)
      const roots = children.get(null) ?? [];
      let hiddenCount = 0;
      for (const root of roots) {
        if (hideCompletedSubtrees && isSubtreeCompleted(root.id)) {
          hiddenCount++;
          continue;
        }
        renderNode(root, 0);
      }

      return { lines, hiddenCount };
    } catch (err) {
      return { lines: [`{red-fg}Error loading tasks: ${err}{/red-fg}`], hiddenCount: 0 };
    }
  }

  function statusSymbol(status: string, assignedRole?: string | null): string {
    // Human-attention-needed tasks (assigned_role = 'human') are always red
    if (assignedRole === 'human') {
      const icon = status === 'completed' ? '✓'
        : status === 'in_progress' ? '▶'
        : status === 'eligible' ? '○'
        : status === 'pending' ? '…'
        : status === 'failed' ? '✗'
        : status === 'draft' ? '□'
        : '?';
      return `{red-fg}${icon}{/red-fg}`;
    }
    switch (status) {
      case 'completed':   return '{green-fg}✓{/green-fg}';
      case 'in_progress': return '{green-fg}▶{/green-fg}';
      case 'eligible':    return '{cyan-fg}○{/cyan-fg}';
      case 'pending':     return '{grey-fg}…{/grey-fg}';
      case 'failed':      return '{#FF8C00-fg}✗{/#FF8C00-fg}';
      case 'draft':       return '{grey-fg}□{/grey-fg}';
      default:            return '{white-fg}?{/white-fg}';
    }
  }

  // ── Render functions ───────────────────────────────────────────────────

  function renderFleetStatus(counts: StatusCounts): void {
    const lines = [
      '',
      `  {bold}Status{/bold}        {bold}Count{/bold}`,
      `  ─────────── ─────`,
      `  {grey-fg}pending{/grey-fg}     ${String(counts.pending).padStart(5)}`,
      `  {cyan-fg}eligible{/cyan-fg}    ${String(counts.eligible).padStart(5)}`,
      `  {green-fg}in_progress{/green-fg} ${String(counts.in_progress).padStart(5)}`,
      `  {green-fg}completed{/green-fg}   ${String(counts.completed).padStart(5)}`,
      `  {#FF8C00-fg}failed{/#FF8C00-fg}      ${String(counts.failed).padStart(5)}`,
      counts.draft > 0 ? `  {grey-fg}draft{/grey-fg}       ${String(counts.draft).padStart(5)}` : null,
      `  ─────────── ─────`,
      `  {bold}total{/bold}       ${String(counts.total).padStart(5)}`,
    ].filter(Boolean) as string[];
    fleetBox.setContent(lines.join('\n'));
  }

  function roleTag(role: string | null): string {
    switch (role) {
      case 'implementer': return '{green-fg}impl{/green-fg}';
      case 'refiner':     return '{yellow-fg}rfnr{/yellow-fg}';
      case 'planner':     return '{cyan-fg}plnr{/cyan-fg}';
      case 'tq-writer':   return '{grey-fg}writ{/grey-fg}';
      case 'tq-reader':   return '{grey-fg}read{/grey-fg}';
      default:            return role ? `{grey-fg}${role.slice(0, 4)}{/grey-fg}` : '{grey-fg}  ? {/grey-fg}';
    }
  }

  function renderWorkersList(workers: ActiveWorker[]): void {
    if (workers.length === 0) {
      workersList.setItems(['{grey-fg}No active workers{/grey-fg}']);
      return;
    }
    const items = workers.map((_w, i) => {
      const w = workers[i]!;
      const elapsed = w.claimedAt ? elapsedStr(w.claimedAt) : '?';
      const shortId = w.agentId.slice(0, 8);
      const desc = w.description.length > 30
        ? w.description.slice(0, 27) + '...'
        : w.description;
      return `${shortId} │ ${roleTag(w.role)} │ ${w.taskId} │ ${desc} │ ${elapsed}`;
    });
    workersList.setItems(items);
    if (selectedWorkerIdx >= workers.length) {
      selectedWorkerIdx = Math.max(0, workers.length - 1);
    }
    workersList.select(selectedWorkerIdx);
  }

  function elapsedStr(since: Date): string {
    const ms = Date.now() - new Date(since).getTime();
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  }

  // ── Log tailing ────────────────────────────────────────────────────────

  async function tailWorkerLog(worker: ActiveWorker): Promise<void> {
    // Skip if same worker+task is already loaded
    if (worker.agentId === currentLogWorkerId && worker.taskId === currentLogTaskId) return;
    currentLogWorkerId = worker.agentId;
    currentLogTaskId = worker.taskId;
    currentLogPath = null;
    currentLogOffset = 0;
    logBox.setContent('');
    logBox.setLabel(` Worker Log: ${worker.agentId.slice(0, 8)} │ ${worker.taskId} `);

    // Find the log file for this task in the flat layout (data/work-logs/<task-id>*.jsonl)
    const base = workLogsDir();
    try {
      const entries = await readdir(base);
      // Match files named <task-id>.jsonl or <task-id>.<suffix>.jsonl
      const taskPrefix = worker.taskId + '.';
      const exactName = worker.taskId + '.jsonl';
      const matchingFiles = entries.filter(e =>
        e === exactName || (e.startsWith(taskPrefix) && e.endsWith('.jsonl')),
      );
      if (matchingFiles.length === 0) {
        logBox.log('{grey-fg}No log files for this task{/grey-fg}');
        screen.render();
        return;
      }
      // Find most recently modified
      let latestPath = '';
      let latestMtime = 0;
      for (const f of matchingFiles) {
        const p = join(base, f);
        const s = await stat(p);
        if (s.mtimeMs > latestMtime) {
          latestMtime = s.mtimeMs;
          latestPath = p;
        }
      }
      if (latestPath) {
        currentLogPath = latestPath;
        await loadLogFile(latestPath);
      }
    } catch {
      logBox.log('{grey-fg}No logs directory{/grey-fg}');
    }
    screen.render();
  }

  async function loadLogFile(path: string): Promise<void> {
    return new Promise((resolve) => {
      const stream = createReadStream(path, { encoding: 'utf8' });
      const rl = createInterface({ input: stream });
      rl.on('line', (line: string) => {
        try {
          const event = JSON.parse(line) as StreamEvent;
          const formatted = formatEvent(event);
          if (formatted) logBox.log(formatted);
        } catch {
          logBox.log(line);
        }
      });
      rl.on('close', () => {
        try {
          const s = statSync(path);
          currentLogOffset = s.size;
        } catch { /* ignore */ }
        resolve();
      });
    });
  }

  async function refreshLogTail(): Promise<void> {
    if (!currentLogTaskId) return;

    // If we have a tracked log path, check for new content there first.
    // Also check for newer log files matching this task (e.g. on retry).
    const base = workLogsDir();
    try {
      const entries = await readdir(base);
      const taskPrefix = currentLogTaskId + '.';
      const exactName = currentLogTaskId + '.jsonl';
      const matchingFiles = entries.filter(e =>
        e === exactName || (e.startsWith(taskPrefix) && e.endsWith('.jsonl')),
      );
      let latestPath = '';
      let latestMtime = 0;
      for (const f of matchingFiles) {
        const p = join(base, f);
        const s = await stat(p);
        if (s.mtimeMs > latestMtime) {
          latestMtime = s.mtimeMs;
          latestPath = p;
        }
      }
      if (!latestPath) return;

      // If a newer log file appeared (e.g. on retry), switch to it
      if (latestPath !== currentLogPath) {
        currentLogPath = latestPath;
        currentLogOffset = 0;
        logBox.setContent('');
        await loadLogFile(latestPath);
        screen.render();
        return;
      }

      const s = await stat(latestPath);
      if (s.size > currentLogOffset) {
        // Read new data
        await new Promise<void>((resolve) => {
          const stream = createReadStream(latestPath, {
            start: currentLogOffset,
            encoding: 'utf8',
          });
          const rl = createInterface({ input: stream });
          rl.on('line', (line: string) => {
            try {
              const event = JSON.parse(line) as StreamEvent;
              const formatted = formatEvent(event);
              if (formatted) logBox.log(formatted);
            } catch {
              logBox.log(line);
            }
          });
          rl.on('close', resolve);
        });
        currentLogOffset = s.size;
        screen.render();
      }
    } catch {
      // ignore
    }
  }

  // ── Full-screen log overlay ────────────────────────────────────────────

  /**
   * Open a full-screen overlay showing formatted log content for a given log
   * file path. If logPath is null, shows a "no logs" message. Pressing Escape
   * or q closes the overlay and returns focus to the dashboard.
   */
  async function showLogOverlay(title: string, logPath: string | null): Promise<void> {
    const overlay = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      label: ` ${title} — {bold}Esc{/bold}/{bold}q{/bold} to close `,
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
        label: { fg: 'white', bold: true },
        bg: 'black',
        fg: 'white',
      },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { style: { bg: 'grey' } },
      mouse: true,
      keys: true,
      vi: true,
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
    });

    // Render log content into the overlay
    if (!logPath) {
      overlay.setContent('{grey-fg}No logs available for this task{/grey-fg}');
    } else {
      overlay.setContent('{grey-fg}Loading…{/grey-fg}');
      screen.render();

      const lines: string[] = [];
      await new Promise<void>((resolve) => {
        const stream = createReadStream(logPath, { encoding: 'utf8' });
        const rl = createInterface({ input: stream });
        rl.on('line', (line: string) => {
          try {
            const event = JSON.parse(line) as StreamEvent;
            const formatted = formatEvent(event);
            if (formatted) lines.push(formatted);
          } catch {
            // skip unparseable lines
          }
        });
        rl.on('close', resolve);
      });

      if (lines.length === 0) {
        overlay.setContent('{grey-fg}Log file exists but contains no displayable messages{/grey-fg}');
      } else {
        overlay.setContent(lines.join('\n'));
      }

      // Scroll to the bottom so the most recent content is visible
      overlay.setScrollPerc(100);
    }

    screen.render();
    overlay.focus();

    function closeOverlay(): void {
      overlay.destroy();
      // Restore focus based on the currently focused panel
      if (focusedPanel === 'pipeline') {
        pipelineBox.focus();
      } else {
        workersList.focus();
      }
      screen.render();
    }

    overlay.key(['escape', 'q'], closeOverlay);
  }

  // ── Refresh loop ───────────────────────────────────────────────────────

  async function refresh(): Promise<void> {
    try {
      const [counts, workers, tree] = await Promise.all([
        fetchStatusCounts(),
        fetchActiveWorkers(),
        fetchTaskTree(),
      ]);

      activeWorkers = workers;
      renderFleetStatus(counts);
      renderWorkersList(workers);

      // Update pipeline
      const { lines: treeLines, hiddenCount } = tree;
      const hiddenLabel = hiddenCount > 0
        ? ` {grey-fg}(${hiddenCount} completed subtree${hiddenCount > 1 ? 's' : ''} hidden){/grey-fg}`
        : '';
      pipelineBox.setLabel(` Task Pipeline${hiddenLabel} `);
      const legendLine = `{grey-fg}Legend:{/grey-fg} {green-fg}✓{/green-fg} done  {yellow-fg}▶{/yellow-fg} running  {cyan-fg}○{/cyan-fg} eligible  {grey-fg}…{/grey-fg} pending  {red-fg}✗{/red-fg} failed  {grey-fg}□{/grey-fg} draft`;
      if (treeLines.length === 0) {
        pipelineBox.setItems([
          legendLine,
          hiddenCount > 0
            ? `{grey-fg}All visible tasks filtered — press {bold}h{/bold} to show completed subtrees{/grey-fg}`
            : '{grey-fg}No tasks{/grey-fg}',
        ]);
      } else {
        pipelineBox.setItems([legendLine, ...treeLines]);
      }

      // Auto-select first worker's log if none selected
      if (!currentLogWorkerId && workers.length > 0) {
        await tailWorkerLog(workers[0]!);
      }

      // Refresh tail of current log
      await refreshLogTail();

      screen.render();
    } catch (err) {
      statusBar.setContent(` {red-fg}Error: ${err}{/red-fg}`);
      screen.render();
    }
  }

  // ── Keyboard bindings ──────────────────────────────────────────────────

  screen.key(['q', 'C-c'], async () => {
    await pool.end();
    screen.destroy();
    process.exit(0);
  });

  screen.key(['tab'], () => {
    if (focusedPanel === 'workers') {
      focusedPanel = 'pipeline';
      pipelineBox.focus();
      (workersList.style as Record<string, unknown>).border = { fg: 'green' };
      (pipelineBox.style as Record<string, unknown>).border = { fg: 'white' };
    } else {
      focusedPanel = 'workers';
      workersList.focus();
      (pipelineBox.style as Record<string, unknown>).border = { fg: 'magenta' };
      (workersList.style as Record<string, unknown>).border = { fg: 'white' };
    }
    screen.render();
  });

  screen.key(['r'], () => {
    refresh();
  });

  screen.key(['h'], () => {
    hideCompletedSubtrees = !hideCompletedSubtrees;
    refresh();
  });

  workersList.on('select item', async (_item: unknown, index: number) => {
    selectedWorkerIdx = index;
    if (activeWorkers[index]) {
      await tailWorkerLog(activeWorkers[index]!);
    }
  });

  // Enter on Active Workers → open full-screen log overlay for selected worker
  workersList.key(['enter'], async () => {
    const idx = (workersList as unknown as { selected: number }).selected ?? 0;
    const worker = activeWorkers[idx];
    if (!worker) {
      await showLogOverlay('No worker selected', null);
      return;
    }

    // Find the log file for this worker's task (same logic as tailWorkerLog)
    const base = workLogsDir();
    let logPath: string | null = null;
    try {
      const entries = await readdir(base);
      const taskPrefix = worker.taskId + '.';
      const exactName = worker.taskId + '.jsonl';
      const matchingFiles = entries.filter(e =>
        e === exactName || (e.startsWith(taskPrefix) && e.endsWith('.jsonl')),
      );
      if (matchingFiles.length > 0) {
        let latestMtime = 0;
        for (const f of matchingFiles) {
          const p = join(base, f);
          const s = await stat(p);
          if (s.mtimeMs > latestMtime) {
            latestMtime = s.mtimeMs;
            logPath = p;
          }
        }
      }
    } catch {
      // no logs dir — logPath stays null
    }

    const title = `${worker.agentId.slice(0, 8)} │ ${worker.taskId} │ ${worker.description.slice(0, 40)}`;
    await showLogOverlay(title, logPath);
  });

  // Also handle up/down navigation updating the log panel
  workersList.key(['up', 'down', 'k', 'j'], async () => {
    // blessed updates the selection index before our handler fires
    // Use a small delay to let blessed update internal state
    setTimeout(async () => {
      const idx = (workersList as unknown as { selected: number }).selected ?? 0;
      selectedWorkerIdx = idx;
      if (activeWorkers[idx]) {
        await tailWorkerLog(activeWorkers[idx]!);
      }
    }, 10);
  });

  // Enter on Task Pipeline → open full-screen log overlay for the selected task
  pipelineBox.key(['enter'], async () => {
    const idx = (pipelineBox as unknown as { selected: number }).selected ?? 0;
    // Pipeline items array: [legendLine, ...treeLines], so treeLines start at index 1.
    // Extract the task ID from the selected line using a regex.
    const items = (pipelineBox as unknown as { items: Array<{ getText?: () => string; content?: string }> }).items;
    const rawItem = items[idx];
    const rawText: string = typeof rawItem?.getText === 'function'
      ? rawItem.getText()
      : (rawItem?.content ?? String(rawItem ?? ''));
    // Strip blessed markup tags to get plain text, then extract task ID
    const plain = rawText.replace(/\{[^}]+\}/g, '');
    const match = plain.match(/tq-[a-f0-9]+(?:\.[a-f0-9]+)*/i);
    if (!match) {
      // Selected item has no task ID (e.g. legend line) — do nothing
      return;
    }
    const taskId = match[0];

    // Find the log file for this task (flat layout: data/work-logs/<task-id>.jsonl)
    const base = workLogsDir();
    let logPath: string | null = null;
    try {
      const entries = await readdir(base);
      const taskPrefix = taskId + '.';
      const exactName = taskId + '.jsonl';
      const matchingFiles = entries.filter(e =>
        e === exactName || (e.startsWith(taskPrefix) && e.endsWith('.jsonl')),
      );
      if (matchingFiles.length > 0) {
        let latestMtime = 0;
        for (const f of matchingFiles) {
          const p = join(base, f);
          const s = await stat(p);
          if (s.mtimeMs > latestMtime) {
            latestMtime = s.mtimeMs;
            logPath = p;
          }
        }
      }
    } catch {
      // no logs dir — logPath stays null
    }

    const title = `Task ${taskId}`;
    await showLogOverlay(title, logPath);
  });

  // ── Start ──────────────────────────────────────────────────────────────

  workersList.focus();
  await refresh();

  // Refresh every 3 seconds
  const refreshTimer = setInterval(() => {
    refresh();
  }, 3000);

  // Refresh log tail more frequently
  const logTimer = setInterval(() => {
    refreshLogTail();
  }, 1000);

  screen.on('destroy', () => {
    clearInterval(refreshTimer);
    clearInterval(logTimer);
  });

  screen.render();
}
