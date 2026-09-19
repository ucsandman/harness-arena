import pc from 'picocolors';
import { METRIC_LABELS } from '@harness-arena/protocol';
import type { ArenaEvent, BattleRecord, MetricKey, MetricValue, Side } from '@harness-arena/protocol';
import { humanDuration } from '@harness-arena/core';
import type { Logger } from '@harness-arena/adapters';
import type { CliDeps } from './deps.js';

/**
 * Terminal output. Two rules the whole CLI depends on:
 *
 *  1. with `--json`, stdout carries nothing but one JSON document; every human line goes to stderr;
 *  2. colour is off when NO_COLOR is set, when stdout is not a terminal, or in `--json` mode.
 */

export interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
}

export interface Symbols {
  ok: string;
  no: string;
  unknown: string;
  dot: string;
  arrow: string;
}

export interface Ui {
  readonly json: boolean;
  readonly color: boolean;
  readonly tty: boolean;
  readonly c: Palette;
  readonly sym: Symbols;
  /** a human line: stdout normally, stderr in --json mode */
  line(text?: string): void;
  /** the machine-readable result; only ever called once per command */
  emitJson(value: unknown): void;
  heading(text: string): void;
  detail(label: string, value: string, width?: number): void;
  success(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  /** always stderr, never stdout: progress and status */
  status(text: string): void;
  table(rows: string[][], head?: string[]): void;
}

const IDENTITY = (s: string) => s;

function palette(color: boolean): Palette {
  if (!color) {
    return {
      bold: IDENTITY,
      dim: IDENTITY,
      red: IDENTITY,
      green: IDENTITY,
      yellow: IDENTITY,
      cyan: IDENTITY,
    };
  }
  return {
    bold: (s) => pc.bold(s),
    dim: (s) => pc.dim(s),
    red: (s) => pc.red(s),
    green: (s) => pc.green(s),
    yellow: (s) => pc.yellow(s),
    cyan: (s) => pc.cyan(s),
  };
}

/** Windows consoles outside Windows Terminal / VS Code still mangle box-drawing glyphs. */
export function supportsUnicode(deps: Pick<CliDeps, 'env' | 'platform'>): boolean {
  if (deps.platform !== 'win32') return true;
  const env = deps.env;
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.ConEmuANSI === 'ON' || env.CI);
}

function symbols(unicode: boolean): Symbols {
  return unicode
    ? { ok: '✓', no: '✗', unknown: '?', dot: '•', arrow: '→' }
    : { ok: 'v', no: 'x', unknown: '?', dot: '-', arrow: '->' };
}

export function createUi(deps: CliDeps, opts: { json?: boolean } = {}): Ui {
  const json = opts.json === true;
  const noColor = Boolean(deps.env.NO_COLOR && deps.env.NO_COLOR !== '0');
  const color = !json && !noColor && deps.isTTY && pc.isColorSupported;
  const c = palette(color);
  const sym = symbols(supportsUnicode(deps));
  const human = (text: string) => {
    if (json) deps.writeErr(text);
    else deps.writeOut(text);
  };

  return {
    json,
    color,
    tty: deps.isTTY && !json,
    c,
    sym,
    line: (text = '') => human(text + '\n'),
    emitJson: (value) => deps.writeOut(JSON.stringify(value, null, 2) + '\n'),
    heading: (text) => human('\n' + c.bold(text) + '\n'),
    detail: (label, value, width = 16) => {
      // A label longer than the column still gets a gap, so nothing ever runs into its value.
      const padded = label.length >= width ? label + '  ' : label.padEnd(width);
      human('  ' + c.dim(padded) + value + '\n');
    },
    success: (text) => human(c.green(sym.ok) + ' ' + text + '\n'),
    warn: (text) => deps.writeErr(c.yellow('! ') + text + '\n'),
    error: (text) => deps.writeErr(c.red(sym.no) + ' ' + text + '\n'),
    status: (text) => deps.writeErr(text + '\n'),
    table: (rows, head) => {
      const all = head ? [head, ...rows] : rows;
      const columns = Math.max(0, ...all.map((r) => r.length));
      const widths: number[] = [];
      for (let i = 0; i < columns; i++) {
        widths[i] = Math.max(...all.map((r) => (r[i] ?? '').length));
      }
      const render = (row: string[], bold: boolean) => {
        const cells = row.map((cell, i) => (i === columns - 1 ? cell : cell.padEnd(widths[i] ?? 0)));
        const text = '  ' + cells.join('  ');
        human((bold ? c.bold(text) : text) + '\n');
      };
      if (head) render(head, true);
      for (const row of rows) render(row, false);
    },
  };
}

/** A logger that surfaces warnings and errors from core on stderr and drops the rest. */
export function createUiLogger(ui: Ui): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => ui.warn(msg),
    error: (msg) => ui.error(msg),
    child: () => logger,
  };
  return logger;
}

// ---- metrics ----------------------------------------------------------------------------------

/** The compact set shown in the terminal; the HTML report shows everything. */
export const TERMINAL_METRICS: readonly MetricKey[] = [
  'completion_status',
  'tests_passed',
  'tests_failed',
  'regressions',
  'duration_ms',
  'tokens_total',
  'cost_usd',
  'turns',
  'tool_calls',
  'files_changed',
  'lines_added',
  'lines_removed',
];

/** Never invents a number: an unavailable metric is "n/a", never 0. */
export function formatMetric(key: MetricKey, metric: MetricValue | undefined): string {
  if (!metric || metric.status === 'unavailable' || metric.value === null) return 'n/a';
  const value = metric.value;
  let text: string;
  if (key === 'duration_ms' && typeof value === 'number') text = humanDuration(value);
  else if (key === 'cost_usd' && typeof value === 'number') text = '$' + value.toFixed(value >= 1 ? 2 : 4);
  else text = String(value);
  return metric.status === 'estimated' ? text + ' (est)' : text;
}

export function metricsTable(record: BattleRecord): { head: string[]; rows: string[][] } {
  const rows: string[][] = [];
  for (const key of TERMINAL_METRICS) {
    const a = formatMetric(key, record.runs.a.metrics[key]);
    const b = formatMetric(key, record.runs.b.metrics[key]);
    if (a === 'n/a' && b === 'n/a') continue;
    rows.push([METRIC_LABELS[key], a, b]);
  }
  return { head: ['Metric', record.runs.a.label, record.runs.b.label], rows };
}

/** `2026-09-19 14:03Z` — short, sortable, timezone-explicit. */
export function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

// ---- live status ------------------------------------------------------------------------------

export interface StatusView {
  battle(status: string, detail?: string): void;
  side(side: Side, patch: { status?: string; last?: string; startedAtMs?: number }): void;
  observe(event: ArenaEvent): void;
  stop(): void;
}

/** A one-line summary of an event for the live status line. Never prints prompt or file contents. */
export function describeEvent(event: ArenaEvent): string {
  switch (event.type) {
    case 'tool.called':
      return 'tool ' + event.payload.name;
    case 'tool.result':
      return 'tool ' + (event.payload.name ?? 'result') + (event.payload.ok ? ' ok' : ' failed');
    case 'command.started':
      return 'command';
    case 'command.completed':
      return 'command exit ' + String(event.payload.exitCode ?? '?');
    case 'file.changed':
      return event.payload.kind + ' ' + event.payload.path;
    case 'file.read':
      return 'read ' + event.payload.path;
    case 'test.completed':
      return (
        'tests ' +
        String(event.payload.passed ?? '?') +
        ' passed, ' +
        String(event.payload.failed ?? '?') +
        ' failed'
      );
    case 'model.response':
      return 'model response';
    case 'agent.thinking':
      return 'thinking';
    case 'agent.output':
      return 'output';
    case 'subagent.spawned':
      return 'subagent ' + (event.payload.name ?? 'spawned');
    case 'limit.hit':
      return 'limit ' + event.payload.kind;
    case 'error':
      return 'error';
    default:
      return event.type;
  }
}

const REDRAW_MS = 120;

/**
 * Three lines on a terminal (battle, side A, side B) redrawn in place, driven by real events. On a
 * non-terminal it prints one line per status change instead: no spinner that keeps moving while
 * nothing happens.
 */
export function createStatusView(
  ui: Ui,
  labels: Record<Side, string>,
  opts: { tty: boolean; now: () => number; write: (text: string) => void },
): StatusView {
  const state: Record<Side, { status: string; last: string; startedAtMs: number | null }> = {
    a: { status: 'pending', last: '', startedAtMs: null },
    b: { status: 'pending', last: '', startedAtMs: null },
  };
  let battleStatus = 'pending';
  let drawn = false;
  let lastDraw = 0;
  let stopped = false;

  const elapsed = (side: Side): string => {
    const started = state[side].startedAtMs;
    if (started === null) return '';
    return ' ' + ui.c.dim(humanDuration(Math.max(0, opts.now() - started)));
  };

  const sideLine = (side: Side): string => {
    const s = state[side];
    const label = labels[side] || side.toUpperCase();
    const mark =
      s.status === 'completed'
        ? ui.c.green(ui.sym.ok)
        : s.status === 'failed' || s.status === 'timed_out' || s.status === 'interrupted'
          ? ui.c.red(ui.sym.no)
          : ui.c.dim(ui.sym.dot);
    const last = s.last ? ' ' + ui.c.dim(ui.sym.arrow + ' ' + s.last) : '';
    return '  ' + mark + ' ' + label + '  ' + s.status + elapsed(side) + last;
  };

  const render = (force: boolean): void => {
    if (stopped || !opts.tty) return;
    const now = opts.now();
    if (!force && drawn && now - lastDraw < REDRAW_MS) return;
    lastDraw = now;
    const lines = [ui.c.bold('Battle: ') + battleStatus, sideLine('a'), sideLine('b')];
    const prefix = drawn ? '\x1b[3A' : '';
    opts.write(prefix + lines.map((l) => '\x1b[2K' + l + '\n').join(''));
    drawn = true;
  };

  return {
    battle(status, detail) {
      battleStatus = detail ? status + ' (' + detail + ')' : status;
      if (!opts.tty) opts.write('battle: ' + battleStatus + '\n');
      render(true);
    },
    side(side, patch) {
      const before = state[side].status;
      if (patch.status !== undefined) state[side].status = patch.status;
      if (patch.last !== undefined) state[side].last = patch.last;
      if (patch.startedAtMs !== undefined) state[side].startedAtMs = patch.startedAtMs;
      if (!opts.tty && patch.status !== undefined && patch.status !== before) {
        opts.write(side + ' ' + (labels[side] || side) + ': ' + patch.status + '\n');
      }
      render(patch.status !== undefined && patch.status !== before);
    },
    observe(event) {
      if (event.type === 'run.started' && event.side) {
        this.side(event.side, { status: 'running', startedAtMs: Date.parse(event.ts) || opts.now() });
        return;
      }
      if (event.type === 'run.completed' && event.side) {
        this.side(event.side, { status: event.payload.status, last: '' });
        return;
      }
      if (event.side) this.side(event.side, { last: describeEvent(event) });
    },
    stop() {
      render(true);
      stopped = true;
    },
  };
}
