import blessed from 'blessed';
import type { Widgets } from 'blessed';

/**
 * Creates all blessed widgets for the Shardworks dashboard and attaches them
 * to the given screen. Returns a plain object with every widget as a named
 * property so callers can reference them by name.
 *
 * No side-effects beyond widget construction — no DB access, no I/O.
 */
export function createDashboardLayout(screen: Widgets.Screen): {
  leftCol: Widgets.BoxElement;
  rightCol: Widgets.BoxElement;
  fleetBox: Widgets.BoxElement;
  workersBox: Widgets.ListElement;
  logBox: Widgets.Log;
  pipelineContainer: Widgets.BoxElement;
  pipelineLegend: Widgets.BoxElement;
  pipelineList: Widgets.ListElement;
  filterInput: Widgets.TextboxElement;
  statusBar: Widgets.BoxElement;
} {
  // ── Left column (33%) ────────────────────────────────────────────────────

  const leftCol = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '33%',
    height: '100%',
  });

  // ── Right column (67%) ───────────────────────────────────────────────────

  const rightCol = blessed.box({
    parent: screen,
    top: 0,
    left: '33%',
    width: '67%',
    height: '100%',
  });

  // ── Fleet Status (top-left, 30%) ─────────────────────────────────────────

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

  // ── Active Workers (middle-left, 30%) ────────────────────────────────────

  const workersBox = blessed.list({
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

  // ── Worker Log (bottom-left, 40%) ────────────────────────────────────────

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

  // ── Pipeline container (right column, full height) ───────────────────────

  const pipelineContainer = blessed.box({
    parent: rightCol,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    label: ' Task Pipeline ',
    border: { type: 'line' },
    style: {
      border: { fg: 'magenta' },
      label: { fg: 'white', bold: true },
    },
    tags: true,
  });

  // ── Pipeline legend (1 line, pinned at top) ──────────────────────────────

  const pipelineLegend = blessed.box({
    parent: pipelineContainer,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    padding: { left: 1, right: 1 },
    content: `{grey-fg}Legend:{/grey-fg} {green-fg}✓{/green-fg} done  {yellow-fg}▶{/yellow-fg} running  {cyan-fg}○{/cyan-fg} eligible  {grey-fg}…{/grey-fg} pending  {red-fg}✗{/red-fg} failed  {grey-fg}□{/grey-fg} draft`,
  });

  // ── Pipeline list (scrollable task tree, below the legend) ───────────────

  const pipelineList = blessed.list({
    parent: pipelineContainer,
    top: 1,
    left: 0,
    width: '100%',
    height: '100%-1',
    style: {
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

  // ── Pipeline filter input (1 line, pinned at bottom, hidden by default) ──

  const filterInput = blessed.textbox({
    parent: pipelineContainer,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    style: {
      fg: 'white',
      bg: '#1a1a1a',
      focus: { fg: 'white', bg: '#2a2a2a' },
    },
    hidden: true,
    inputOnFocus: true,
    keys: true,
    tags: false,
  } as Widgets.TextboxOptions);

  // ── Status bar ───────────────────────────────────────────────────────────

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    style: { bg: 'blue', fg: 'white' },
    tags: true,
    content: ' {bold}q{/bold} quit | {bold}↑↓{/bold} navigate | {bold}Enter{/bold}/{bold}Space{/bold} collapse/expand | {bold}o{/bold} view logs | {bold}Tab{/bold} switch panel | {bold}r{/bold} refresh | {bold}h{/bold} hide completed',
  });

  return {
    leftCol,
    rightCol,
    fleetBox,
    workersBox,
    logBox,
    pipelineContainer,
    pipelineLegend,
    pipelineList,
    filterInput,
    statusBar,
  };
}
