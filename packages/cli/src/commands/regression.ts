import fs from 'node:fs';
import path from 'node:path';
import type { BattleRecord, BattleSpec, MetricKey, Side } from '@harness-arena/protocol';
import type { CliDeps } from '../deps.js';
import { createUi, formatMetric } from '../ui.js';
import type { Ui } from '../ui.js';
import { resolveHome } from '../config.js';
import { parseSpec, readSpecFile } from '../spec.js';
import { executeBattle } from '../runner.js';
import { CliError } from '../errors.js';

export interface RegressionFlags {
  baseline?: string;
  candidate?: string;
  agent?: string;
  json?: boolean;
  markdown?: string;
  trust?: boolean;
  home?: string;
}

export interface SideSummary {
  label: string;
  status: string;
  testsPassed: number | null;
  testsFailed: number | null;
  durationMs: number | null;
  tokens: number | null;
  costUsd: number | null;
}

export interface RegressionRow {
  spec: string;
  battleId: string;
  status: string;
  winner: string | null;
  baseline: SideSummary;
  candidate: SideSummary;
  regression: boolean;
  reasons: string[];
}

export interface RegressionSummary {
  battles: number;
  baselineCompleted: number;
  candidateCompleted: number;
  /** percentage points, candidate minus baseline */
  completionDeltaPercent: number;
  /** percent change of the candidate against the baseline; null when the baseline reports nothing */
  tokensDeltaPercent: number | null;
  durationDeltaPercent: number | null;
  regressions: number;
  failed: boolean;
}

function numberMetric(record: BattleRecord, side: Side, key: MetricKey): number | null {
  const metric = record.runs[side].metrics[key];
  if (!metric || metric.status === 'unavailable') return null;
  return typeof metric.value === 'number' ? metric.value : null;
}

function sideSummary(record: BattleRecord, side: Side): SideSummary {
  return {
    label: record.runs[side].label,
    status: record.runs[side].status,
    testsPassed: numberMetric(record, side, 'tests_passed'),
    testsFailed: numberMetric(record, side, 'tests_failed'),
    durationMs: record.runs[side].durationMs,
    tokens: numberMetric(record, side, 'tokens_total'),
    costUsd: numberMetric(record, side, 'cost_usd'),
  };
}

/** Side A is always the baseline, side B the candidate. */
export function rowFromRecord(specName: string, record: BattleRecord): RegressionRow {
  const baseline = sideSummary(record, 'a');
  const candidate = sideSummary(record, 'b');
  const reasons: string[] = [];
  if (baseline.status === 'completed' && candidate.status !== 'completed') {
    reasons.push('the candidate did not complete (' + candidate.status + ')');
  }
  if (
    baseline.testsFailed !== null &&
    candidate.testsFailed !== null &&
    candidate.testsFailed > baseline.testsFailed
  ) {
    reasons.push(
      'tests failing went from ' + String(baseline.testsFailed) + ' to ' + String(candidate.testsFailed),
    );
  }
  if (
    baseline.testsPassed !== null &&
    candidate.testsPassed !== null &&
    candidate.testsPassed < baseline.testsPassed
  ) {
    reasons.push(
      'tests passing went from ' + String(baseline.testsPassed) + ' to ' + String(candidate.testsPassed),
    );
  }
  return {
    spec: specName,
    battleId: record.id,
    status: record.status,
    winner: record.verdict?.winner ?? null,
    baseline,
    candidate,
    regression: reasons.length > 0,
    reasons,
  };
}

function sum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

function percentChange(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null;
  return Math.round(((after - before) / before) * 100);
}

export function summarizeRegression(rows: readonly RegressionRow[]): RegressionSummary {
  const battles = rows.length;
  const baselineCompleted = rows.filter((row) => row.baseline.status === 'completed').length;
  const candidateCompleted = rows.filter((row) => row.candidate.status === 'completed').length;
  const completionDeltaPercent =
    battles === 0 ? 0 : Math.round(((candidateCompleted - baselineCompleted) / battles) * 100);
  const regressions = rows.filter((row) => row.regression).length;
  return {
    battles,
    baselineCompleted,
    candidateCompleted,
    completionDeltaPercent,
    tokensDeltaPercent: percentChange(
      sum(rows.map((row) => row.baseline.tokens)),
      sum(rows.map((row) => row.candidate.tokens)),
    ),
    durationDeltaPercent: percentChange(
      sum(rows.map((row) => row.baseline.durationMs)),
      sum(rows.map((row) => row.candidate.durationMs)),
    ),
    regressions,
    failed: candidateCompleted < baselineCompleted || regressions > 0,
  };
}

function signed(value: number | null): string {
  if (value === null) return 'n/a';
  return (value > 0 ? '+' : '') + String(value) + ' percent';
}

/** "Completion +6 percent / Tokens -18 percent / Duration -4 percent / Regressions none" */
export function headlineLine(summary: RegressionSummary): string {
  return [
    'Completion ' + signed(summary.completionDeltaPercent),
    'Tokens ' + signed(summary.tokensDeltaPercent),
    'Duration ' + signed(summary.durationDeltaPercent),
    'Regressions ' + (summary.regressions === 0 ? 'none' : String(summary.regressions)),
  ].join(' / ');
}

/** "12/0", or a single n/a when the run reported no test numbers at all. */
function testsCell(side: SideSummary): string {
  if (side.testsPassed === null && side.testsFailed === null) return 'n/a';
  return cell(side.testsPassed, 'count') + '/' + cell(side.testsFailed, 'count');
}

function cell(value: number | null, kind: 'tokens' | 'duration' | 'count'): string {
  if (value === null) return 'n/a';
  if (kind === 'duration') return formatMetric('duration_ms', { value, status: 'calculated' });
  return String(value);
}

export function regressionMarkdown(
  rows: readonly RegressionRow[],
  summary: RegressionSummary,
  labels: { baseline: string; candidate: string },
): string {
  const lines: string[] = [];
  lines.push('## Harness regression: ' + labels.candidate + ' vs ' + labels.baseline);
  lines.push('');
  lines.push(headlineLine(summary));
  lines.push('');
  lines.push(
    '| Spec | Winner | Tests (baseline) | Tests (candidate) | Duration (baseline) | Duration (candidate) | Tokens (baseline) | Tokens (candidate) | Regression |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(
      '| ' +
        [
          row.spec,
          row.winner === 'a' ? 'baseline' : row.winner === 'b' ? 'candidate' : (row.winner ?? 'n/a'),
          testsCell(row.baseline),
          testsCell(row.candidate),
          cell(row.baseline.durationMs, 'duration'),
          cell(row.candidate.durationMs, 'duration'),
          cell(row.baseline.tokens, 'tokens'),
          cell(row.candidate.tokens, 'tokens'),
          row.regression ? row.reasons.join('; ') : 'no',
        ].join(' | ') +
        ' |',
    );
  }
  lines.push('');
  lines.push(
    'Completed: baseline ' +
      String(summary.baselineCompleted) +
      '/' +
      String(summary.battles) +
      ', candidate ' +
      String(summary.candidateCompleted) +
      '/' +
      String(summary.battles) +
      '.',
  );
  lines.push('');
  return lines.join('\n');
}

/** Every *.json spec in the directory, sorted so runs are reproducible. */
export function listSpecFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    throw new CliError('could not read the spec directory: ' + dir);
  }
  const files = entries.filter((entry) => entry.toLowerCase().endsWith('.json')).sort();
  if (files.length === 0) throw new CliError('no *.json battle specs in ' + dir);
  return files.map((file) => path.join(dir, file));
}

function applyCompetitors(
  spec: BattleSpec,
  flags: RegressionFlags,
  baseline: string,
  candidate: string,
): BattleSpec {
  const agentA = flags.agent ?? spec.competitors.a.agent.id;
  const agentB = flags.agent ?? spec.competitors.b.agent.id;
  const next = {
    ...spec,
    competitors: {
      a: {
        ...spec.competitors.a,
        label: 'baseline',
        agent: { ...spec.competitors.a.agent, id: agentA },
        harness: { source: baseline, trusted: flags.trust === true },
      },
      b: {
        ...spec.competitors.b,
        label: 'candidate',
        agent: { ...spec.competitors.b.agent, id: agentB },
        harness: { source: candidate, trusted: flags.trust === true },
      },
    },
    // A regression run is a local CI check: nothing is uploaded.
    privacy: { ...spec.privacy, upload: 'none' as const },
  };
  return parseSpec(next, 'the regression spec');
}

function printTable(ui: Ui, rows: readonly RegressionRow[], summary: RegressionSummary): void {
  ui.table(
    rows.map((row) => [
      row.spec,
      row.winner === 'a' ? 'baseline' : row.winner === 'b' ? 'candidate' : (row.winner ?? 'n/a'),
      testsCell(row.baseline),
      testsCell(row.candidate),
      cell(row.baseline.durationMs, 'duration'),
      cell(row.candidate.durationMs, 'duration'),
      cell(row.baseline.tokens, 'tokens'),
      cell(row.candidate.tokens, 'tokens'),
      row.regression ? ui.c.red('yes') : 'no',
    ]),
    [
      'Spec',
      'Winner',
      'Tests base',
      'Tests cand',
      'Time base',
      'Time cand',
      'Tokens base',
      'Tokens cand',
      'Regression',
    ],
  );
  ui.line();
  ui.line(ui.c.bold(headlineLine(summary)));
  ui.line(
    ui.c.dim(
      'Completed: baseline ' +
        String(summary.baselineCompleted) +
        '/' +
        String(summary.battles) +
        ', candidate ' +
        String(summary.candidateCompleted) +
        '/' +
        String(summary.battles),
    ),
  );
}

/** `arena regression <dir> --baseline <harness> --candidate <harness>` */
export async function regressionCommand(deps: CliDeps, dir: string, flags: RegressionFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  if (!flags.baseline || !flags.candidate) {
    throw new CliError('--baseline <harness> and --candidate <harness> are both required.');
  }
  const specDir = path.resolve(deps.cwd(), dir);
  const files = listSpecFiles(specDir);

  const rows: RegressionRow[] = [];
  for (const file of files) {
    const name = path.basename(file);
    const spec = applyCompetitors(
      parseSpec(readSpecFile(file, deps.cwd()), name),
      flags,
      flags.baseline,
      flags.candidate,
    );
    if (!ui.json)
      ui.status('running ' + name + ' (' + String(rows.length + 1) + '/' + String(files.length) + ')');
    const outcome = await executeBattle(deps, ui, {
      spec,
      home,
      trust: flags.trust === true,
      localOnly: true,
      open: false,
      quiet: true,
    });
    rows.push(rowFromRecord(name, outcome.record));
    if (deps.signal?.aborted) break;
  }

  const summary = summarizeRegression(rows);
  const labels = { baseline: flags.baseline, candidate: flags.candidate };

  if (flags.markdown) {
    const target = path.resolve(deps.cwd(), flags.markdown);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, regressionMarkdown(rows, summary, labels), 'utf8');
    if (!ui.json) ui.success('wrote ' + target);
  }

  if (ui.json) ui.emitJson({ baseline: labels.baseline, candidate: labels.candidate, summary, rows });
  else printTable(ui, rows, summary);

  if (summary.failed) {
    throw new CliError(
      'the candidate harness is not better: ' +
        (summary.candidateCompleted < summary.baselineCompleted
          ? 'it completed ' +
            String(summary.candidateCompleted) +
            ' of ' +
            String(summary.battles) +
            " battles against the baseline's " +
            String(summary.baselineCompleted)
          : String(summary.regressions) + ' regression(s)'),
      1,
    );
  }
}
