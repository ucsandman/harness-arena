import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import {
  benchmarkVersionSummarySchema,
  uploadBenchmarkResponseSchema,
  type BattleRecord,
  type BenchmarkPack,
  type BenchmarkVersionSummary,
  type CompetitorSpec,
  type MetricKey,
  type PrivacySettings,
  type Side,
  type Visibility,
} from '@harness-arena/protocol';
import {
  BenchmarkPackError,
  benchmarkBattleCount,
  expandBenchmark,
  listBenchmarkPackFiles,
  loadBenchmarkPack,
} from '@harness-arena/core';
import { correctnessOf, summarize } from '@harness-arena/evaluator';
import type { CliDeps } from '../deps.js';
import { createUi, formatMetric, shortDate } from '../ui.js';
import type { Ui } from '../ui.js';
import { getToken, resolveHome, resolveServerUrl } from '../config.js';
import { parsePositiveInt, parseSpec, parseUploadLevel, parseVisibility } from '../spec.js';
import { executeBattle } from '../runner.js';
import { getJson, serverError } from './login.js';
import { CliError } from '../errors.js';

/**
 * `arena benchmark` — packs of tasks, run locally.
 *
 * A pack is a file (YAML or JSON) identified by the hash of its content, so everyone who runs
 * `arena-smoke@bmv_…` runs exactly the same tasks. Running one expands it into ordinary battles and
 * puts them through the same executeBattle path as `arena battle` and `arena regression`: the agent
 * CLIs are the user's own, nothing is uploaded unless `--upload` says so, and the server is only ever
 * a catalogue.
 */

export interface BenchmarkCommonFlags {
  json?: boolean;
  home?: string;
}

/** `--server` with no value means "also ask the server"; `--server <url>` names it. */
export interface BenchmarkListFlags extends BenchmarkCommonFlags {
  server?: string | boolean;
  limit?: string;
  category?: string;
}

export interface BenchmarkShowFlags extends BenchmarkCommonFlags {
  server?: string;
  version?: string;
}

export interface BenchmarkPublishFlags extends BenchmarkCommonFlags {
  server?: string;
}

export interface BenchmarkRunFlags extends BenchmarkCommonFlags {
  a?: string;
  b?: string;
  agent?: string;
  trials?: string;
  task?: string;
  upload?: string;
  visibility?: string;
  trust?: boolean;
  markdown?: string;
  server?: string;
}

export const DEFAULT_BENCHMARK_AGENT = 'claude-code';

export interface LocalPack {
  file: string;
  pack: BenchmarkPack;
  versionId: string;
}

export interface LocalPackProblem {
  file: string;
  error: string;
}

/** Where a pack may live without being named by path: the repository's examples, and ARENA_HOME. */
export function localPackDirs(deps: CliDeps, home: string): string[] {
  return [path.join(deps.cwd(), 'examples', 'benchmarks'), path.join(home, 'benchmarks')];
}

export async function loadLocalPacks(
  deps: CliDeps,
  home: string,
): Promise<{ packs: LocalPack[]; problems: LocalPackProblem[] }> {
  const packs: LocalPack[] = [];
  const problems: LocalPackProblem[] = [];
  const seen = new Set<string>();
  for (const dir of localPackDirs(deps, home)) {
    for (const file of listBenchmarkPackFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      try {
        const loaded = await loadBenchmarkPack(file);
        packs.push({ file, ...loaded });
      } catch (err) {
        problems.push({ file, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  packs.sort((x, y) => (x.pack.slug < y.pack.slug ? -1 : x.pack.slug > y.pack.slug ? 1 : 0));
  return { packs, problems };
}

/** A pack argument is a path to a file, or the slug of a pack in one of the local directories. */
export async function resolvePackArg(deps: CliDeps, home: string, target: string): Promise<LocalPack> {
  const asPath = path.resolve(deps.cwd(), target);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
    const loaded = await loadBenchmarkPack(asPath);
    return { file: asPath, ...loaded };
  }
  const { packs } = await loadLocalPacks(deps, home);
  const found = packs.find((candidate) => candidate.pack.slug === target);
  if (found) return found;
  throw new CliError(
    'no benchmark pack at "' +
      target +
      '" and no local pack with that slug. Looked in: ' +
      localPackDirs(deps, home).join(', ') +
      '. Run `arena benchmark list` to see what is available.',
  );
}

// ---- server -------------------------------------------------------------------------------------

export interface ServerSession {
  serverUrl: string;
  token: string | null;
}

export async function serverSession(
  deps: CliDeps,
  home: string,
  flagServer?: string,
): Promise<ServerSession> {
  const store = deps.createStateStore(home);
  const config = await store.getConfig();
  return { serverUrl: resolveServerUrl(deps, config, flagServer), token: await getToken(store) };
}

export async function postJson(
  deps: CliDeps,
  url: string,
  body: unknown,
  token: string,
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'harness-arena/' + deps.arenaVersion,
        authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError('could not reach ' + url + ': ' + (err as Error).message);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** The catalogue as the server sees it. An unreachable or logged-out server is not an error here. */
export async function fetchServerBenchmarks(
  deps: CliDeps,
  session: ServerSession,
  query: { category?: string; limit?: number } = {},
): Promise<{ benchmarks: BenchmarkVersionSummary[]; error: string | null }> {
  if (!session.token) {
    return { benchmarks: [], error: 'not logged in; run `arena login` to see the server catalogue' };
  }
  const params = new URLSearchParams();
  if (query.category) params.set('category', query.category);
  if (query.limit) params.set('limit', String(query.limit));
  const suffix = params.toString().length > 0 ? '?' + params.toString() : '';
  let result: { status: number; json: unknown };
  try {
    result = await getJson(deps, session.serverUrl + '/api/v1/benchmarks' + suffix, session.token);
  } catch (err) {
    return { benchmarks: [], error: err instanceof Error ? err.message : String(err) };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      benchmarks: [],
      error: serverError(result.status, result.json, 'could not read ' + session.serverUrl).message,
    };
  }
  const body = result.json as { benchmarks?: unknown };
  const parsed = benchmarkVersionSummarySchema.array().safeParse(body.benchmarks ?? []);
  if (!parsed.success) return { benchmarks: [], error: 'the server returned an unexpected benchmark list' };
  return { benchmarks: parsed.data, error: null };
}

// ---- list / show / validate / publish -------------------------------------------------------------

/** `arena benchmark list [--server [url]]` */
export async function benchmarkListCommand(deps: CliDeps, flags: BenchmarkListFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const { packs, problems } = await loadLocalPacks(deps, home);
  const limit = flags.limit === undefined ? 50 : parsePositiveInt(flags.limit, '--limit');
  const local = (
    flags.category
      ? packs.filter((entry) => entry.pack.tasks.some((t) => t.category === flags.category))
      : packs
  ).slice(0, limit);

  let remote: { benchmarks: BenchmarkVersionSummary[]; error: string | null } | null = null;
  if (flags.server !== undefined && flags.server !== false) {
    const session = await serverSession(
      deps,
      home,
      typeof flags.server === 'string' ? flags.server : undefined,
    );
    remote = await fetchServerBenchmarks(deps, session, {
      ...(flags.category ? { category: flags.category } : {}),
      limit,
    });
  }

  if (ui.json) {
    ui.emitJson({
      home,
      local: local.map((entry) => ({
        file: entry.file,
        slug: entry.pack.slug,
        name: entry.pack.name,
        version: entry.pack.version,
        versionId: entry.versionId,
        tasks: entry.pack.tasks.length,
        battles: benchmarkBattleCount(entry.pack),
        visibility: entry.pack.visibility,
      })),
      problems,
      ...(remote ? { server: remote.benchmarks, serverError: remote.error } : {}),
    });
    return;
  }

  if (local.length === 0) {
    ui.line('No local benchmark packs. Looked in: ' + localPackDirs(deps, home).join(', '));
  } else {
    ui.heading('Local packs');
    ui.table(
      local.map((entry) => [
        entry.pack.slug,
        entry.pack.version,
        String(entry.pack.tasks.length),
        String(benchmarkBattleCount(entry.pack)),
        entry.versionId,
        path.relative(deps.cwd(), entry.file) || entry.file,
      ]),
      ['Slug', 'Version', 'Tasks', 'Battles', 'Version id', 'File'],
    );
  }
  for (const problem of problems) ui.warn(problem.file + ': ' + problem.error);

  if (remote) {
    if (remote.error) {
      ui.warn(remote.error);
    } else if (remote.benchmarks.length === 0) {
      ui.line();
      ui.line('The server has no benchmark packs you can see.');
    } else {
      ui.heading('Server packs');
      ui.table(
        remote.benchmarks.map((entry) => [
          entry.slug,
          entry.version,
          String(entry.taskCount),
          String(entry.battlesPerRun),
          entry.categories.join(', ') || '-',
          shortDate(entry.createdAt),
        ]),
        ['Slug', 'Version', 'Tasks', 'Battles', 'Categories', 'Published'],
      );
    }
  }
}

function printPack(ui: Ui, entry: LocalPack): void {
  ui.heading(entry.pack.name + ' (' + entry.pack.slug + ')');
  ui.detail('Version', entry.pack.version);
  ui.detail('Version id', entry.versionId);
  ui.detail('Tasks', String(entry.pack.tasks.length));
  ui.detail('Battles per run', String(benchmarkBattleCount(entry.pack)));
  ui.detail('Visibility', entry.pack.visibility);
  ui.detail('File', entry.file);
  if (entry.pack.description) {
    ui.line();
    ui.line('  ' + entry.pack.description);
  }
  ui.line();
  ui.table(
    entry.pack.tasks.map((task) => [
      task.id,
      task.category,
      String(task.trials),
      task.repository.commit
        ? task.repository.source + '@' + task.repository.commit.slice(0, 7)
        : task.repository.source,
      task.title,
    ]),
    ['Task', 'Category', 'Trials', 'Repository', 'Title'],
  );
}

/** `arena benchmark show <pack-or-slug>` — a local file or, when it is only on the server, the catalogue entry. */
export async function benchmarkShowCommand(
  deps: CliDeps,
  target: string,
  flags: BenchmarkShowFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  let entry: LocalPack | null = null;
  try {
    entry = await resolvePackArg(deps, home, target);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    entry = null;
  }

  if (entry) {
    if (ui.json) {
      ui.emitJson({
        file: entry.file,
        versionId: entry.versionId,
        battles: benchmarkBattleCount(entry.pack),
        pack: entry.pack,
      });
    } else {
      printPack(ui, entry);
    }
    return;
  }

  const session = await serverSession(deps, home, flags.server);
  if (!session.token) {
    throw new CliError(
      'no local pack called "' + target + '", and the server catalogue needs a login (`arena login`).',
    );
  }
  const suffix = flags.version ? '?version=' + encodeURIComponent(flags.version) : '';
  const result = await getJson(
    deps,
    session.serverUrl + '/api/v1/benchmarks/' + encodeURIComponent(target) + suffix,
    session.token,
  );
  if (result.status === 404) throw new CliError('the server has no benchmark pack called "' + target + '"');
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not read the benchmark from ' + session.serverUrl);
  }
  if (ui.json) {
    ui.emitJson(result.json);
    return;
  }
  const body = result.json as { benchmark?: BenchmarkVersionSummary; pack?: BenchmarkPack };
  const summary = body.benchmark;
  if (!summary) throw new CliError('the server returned an unexpected benchmark response');
  ui.heading(summary.name + ' (' + summary.slug + ')');
  ui.detail('Version', summary.version);
  ui.detail('Version id', summary.versionId);
  ui.detail('Tasks', String(summary.taskCount));
  ui.detail('Battles per run', String(summary.battlesPerRun));
  ui.detail('Categories', summary.categories.join(', ') || '-');
  ui.detail('Published', shortDate(summary.createdAt));
  ui.detail('Server', session.serverUrl);
}

/** `arena benchmark validate <file>` — parse it, and print the content version id it would publish as. */
export async function benchmarkValidateCommand(
  deps: CliDeps,
  file: string,
  flags: BenchmarkCommonFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const abs = path.resolve(deps.cwd(), file);
  let entry: LocalPack;
  try {
    const loaded = await loadBenchmarkPack(abs);
    entry = { file: abs, ...loaded };
  } catch (err) {
    if (err instanceof BenchmarkPackError) throw new CliError(err.message);
    throw err;
  }
  const categories = [...new Set(entry.pack.tasks.map((task) => task.category))];
  if (ui.json) {
    ui.emitJson({
      valid: true,
      file: abs,
      slug: entry.pack.slug,
      version: entry.pack.version,
      versionId: entry.versionId,
      tasks: entry.pack.tasks.length,
      battles: benchmarkBattleCount(entry.pack),
      categories,
    });
    return;
  }
  ui.success(entry.pack.slug + ' is a valid benchmark pack');
  ui.detail('Version id', entry.versionId);
  ui.detail('Tasks', String(entry.pack.tasks.length));
  ui.detail('Battles per run', String(benchmarkBattleCount(entry.pack)));
  ui.detail('Categories', categories.join(', '));
  ui.line();
  ui.line(ui.c.dim('  the version id is the sha256 of the pack content: edit a task and it changes'));
}

/** `arena benchmark publish <file>` */
export async function benchmarkPublishCommand(
  deps: CliDeps,
  file: string,
  flags: BenchmarkPublishFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const abs = path.resolve(deps.cwd(), file);
  const loaded = await loadBenchmarkPack(abs);
  const session = await serverSession(deps, home, flags.server);
  if (!session.token) {
    throw new CliError('publishing needs an account: run `arena login` first.');
  }
  const result = await postJson(
    deps,
    session.serverUrl + '/api/v1/benchmarks',
    { pack: loaded.pack },
    session.token,
  );
  if (result.status === 401 || result.status === 403) {
    throw serverError(result.status, result.json, 'the server refused the publish');
  }
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not publish to ' + session.serverUrl);
  }
  const parsed = uploadBenchmarkResponseSchema.safeParse(result.json);
  if (!parsed.success) throw new CliError('the server returned an unexpected publish response');
  const response = parsed.data;
  if (ui.json) {
    ui.emitJson({ ...response, file: abs, localVersionId: loaded.versionId });
    return;
  }
  ui.success(
    response.created
      ? 'published ' + response.slug + ' ' + response.version
      : response.slug + ' ' + response.version + ' was already published (identical content)',
  );
  ui.detail('Version id', response.versionId);
  ui.detail('Web', response.url);
}

// ---- run ------------------------------------------------------------------------------------------

export interface BenchmarkSideSummary {
  label: string;
  status: string;
  correct: boolean | null;
  tokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface BenchmarkRunRow {
  taskId: string;
  trial: number;
  category: string;
  battleId: string;
  status: string;
  winner: string | null;
  a: BenchmarkSideSummary;
  b: BenchmarkSideSummary;
}

export interface BenchmarkRunSummary {
  battles: number;
  completed: number;
  wins: { a: number; b: number; ties: number; inconclusive: number };
  correctness: { a: { passed: number; n: number }; b: { passed: number; n: number } };
  medians: {
    tokens: { a: number | null; b: number | null };
    cost: { a: number | null; b: number | null };
    duration: { a: number | null; b: number | null };
  };
  failed: boolean;
}

function numberMetric(record: BattleRecord, side: Side, key: MetricKey): number | null {
  const metric = record.runs[side].metrics[key];
  if (!metric || metric.status === 'unavailable') return null;
  return typeof metric.value === 'number' ? metric.value : null;
}

function sideOf(record: BattleRecord, side: Side): BenchmarkSideSummary {
  const correctness = correctnessOf(record, side);
  return {
    label: record.runs[side].label,
    status: record.runs[side].status,
    correct: correctness.ran ? correctness.passed : null,
    tokens: numberMetric(record, side, 'tokens_total'),
    costUsd: numberMetric(record, side, 'cost_usd'),
    durationMs: record.runs[side].durationMs,
  };
}

export function benchmarkRowFrom(record: BattleRecord): BenchmarkRunRow {
  return {
    taskId: record.spec.benchmark?.taskId ?? record.spec.title ?? record.id,
    trial: record.spec.benchmark?.trial ?? 1,
    category: record.spec.category ?? 'overall',
    battleId: record.id,
    status: record.status,
    winner: record.verdict?.winner ?? null,
    a: sideOf(record, 'a'),
    b: sideOf(record, 'b'),
  };
}

function medianOf(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return summarize(present).median;
}

export function summarizeBenchmarkRun(rows: readonly BenchmarkRunRow[]): BenchmarkRunSummary {
  const wins = { a: 0, b: 0, ties: 0, inconclusive: 0 };
  const correctness = { a: { passed: 0, n: 0 }, b: { passed: 0, n: 0 } };
  for (const row of rows) {
    if (row.winner === 'a') wins.a += 1;
    else if (row.winner === 'b') wins.b += 1;
    else if (row.winner === 'tie') wins.ties += 1;
    else wins.inconclusive += 1;
    for (const side of ['a', 'b'] as const) {
      const value = row[side].correct;
      if (value === null) continue;
      correctness[side].n += 1;
      if (value) correctness[side].passed += 1;
    }
  }
  const completed = rows.filter((row) => row.status === 'completed').length;
  return {
    battles: rows.length,
    completed,
    wins,
    correctness,
    medians: {
      tokens: { a: medianOf(rows.map((r) => r.a.tokens)), b: medianOf(rows.map((r) => r.b.tokens)) },
      cost: { a: medianOf(rows.map((r) => r.a.costUsd)), b: medianOf(rows.map((r) => r.b.costUsd)) },
      duration: {
        a: medianOf(rows.map((r) => r.a.durationMs)),
        b: medianOf(rows.map((r) => r.b.durationMs)),
      },
    },
    failed: completed < rows.length,
  };
}

function correctnessCell(side: { passed: number; n: number }): string {
  if (side.n === 0) return 'n/a';
  return (
    String(side.passed) +
    '/' +
    String(side.n) +
    ' (' +
    String(Math.round((side.passed / side.n) * 100)) +
    '%)'
  );
}

function metricCell(key: MetricKey, value: number | null): string {
  return value === null ? 'n/a' : formatMetric(key, { value, status: 'calculated' });
}

function correctMark(ui: Ui, value: boolean | null): string {
  if (value === null) return '-';
  return value ? ui.c.green(ui.sym.ok) : ui.c.red(ui.sym.no);
}

export function benchmarkMarkdown(
  pack: BenchmarkPack,
  versionId: string,
  labels: { a: string; b: string },
  rows: readonly BenchmarkRunRow[],
  summary: BenchmarkRunSummary,
): string {
  const lines: string[] = [];
  lines.push('## Benchmark: ' + pack.name + ' (' + pack.slug + ' ' + pack.version + ')');
  lines.push('');
  lines.push('Version id `' + versionId + '` · ' + labels.a + ' (A) vs ' + labels.b + ' (B)');
  lines.push('');
  lines.push('| Task | Trial | Category | Winner | Correct A | Correct B | Tokens A | Tokens B | Battle |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(
      '| ' +
        [
          row.taskId,
          String(row.trial),
          row.category,
          row.winner ?? 'n/a',
          row.a.correct === null ? '-' : row.a.correct ? 'yes' : 'no',
          row.b.correct === null ? '-' : row.b.correct ? 'yes' : 'no',
          metricCell('tokens_total', row.a.tokens),
          metricCell('tokens_total', row.b.tokens),
          row.battleId,
        ].join(' | ') +
        ' |',
    );
  }
  lines.push('');
  lines.push(
    'Wins: A ' +
      String(summary.wins.a) +
      ', B ' +
      String(summary.wins.b) +
      ', ties ' +
      String(summary.wins.ties) +
      ', inconclusive ' +
      String(summary.wins.inconclusive) +
      ' over ' +
      String(summary.battles) +
      ' battle(s).',
  );
  lines.push('');
  lines.push(
    'Correctness: A ' +
      correctnessCell(summary.correctness.a) +
      ', B ' +
      correctnessCell(summary.correctness.b) +
      '.',
  );
  lines.push('');
  lines.push(
    'One run of one pack is a sample, not a ranking: see docs/EXPERIMENTS.md for how many battles a claim needs.',
  );
  lines.push('');
  return lines.join('\n');
}

function printRunTable(
  ui: Ui,
  labels: { a: string; b: string },
  rows: readonly BenchmarkRunRow[],
  summary: BenchmarkRunSummary,
): void {
  ui.table(
    rows.map((row) => [
      row.taskId,
      String(row.trial),
      row.category,
      row.winner === 'a' ? labels.a : row.winner === 'b' ? labels.b : (row.winner ?? 'n/a'),
      correctMark(ui, row.a.correct),
      correctMark(ui, row.b.correct),
      metricCell('tokens_total', row.a.tokens),
      metricCell('tokens_total', row.b.tokens),
      metricCell('duration_ms', row.a.durationMs),
      metricCell('duration_ms', row.b.durationMs),
    ]),
    ['Task', 'Trial', 'Category', 'Winner', 'A ok', 'B ok', 'Tokens A', 'Tokens B', 'Time A', 'Time B'],
  );
  ui.line();
  ui.line(
    ui.c.bold(
      'Wins: ' +
        labels.a +
        ' ' +
        String(summary.wins.a) +
        ' / ' +
        labels.b +
        ' ' +
        String(summary.wins.b) +
        ' / ties ' +
        String(summary.wins.ties) +
        ' / inconclusive ' +
        String(summary.wins.inconclusive),
    ),
  );
  ui.line(
    'Correctness: ' +
      labels.a +
      ' ' +
      correctnessCell(summary.correctness.a) +
      ', ' +
      labels.b +
      ' ' +
      correctnessCell(summary.correctness.b),
  );
  ui.line(
    'Median tokens: ' +
      metricCell('tokens_total', summary.medians.tokens.a) +
      ' vs ' +
      metricCell('tokens_total', summary.medians.tokens.b) +
      '  ·  median cost: ' +
      metricCell('cost_usd', summary.medians.cost.a) +
      ' vs ' +
      metricCell('cost_usd', summary.medians.cost.b) +
      '  ·  median time: ' +
      metricCell('duration_ms', summary.medians.duration.a) +
      ' vs ' +
      metricCell('duration_ms', summary.medians.duration.b),
  );
  ui.line(
    ui.c.dim(
      String(summary.completed) + ' of ' + String(summary.battles) + ' battle(s) completed on this machine',
    ),
  );
}

export function competitorFor(source: string, agentId: string, trusted: boolean): CompetitorSpec {
  return {
    label: source,
    agent: { id: agentId as CompetitorSpec['agent']['id'] },
    harness: { source, trusted },
  };
}

/** `arena benchmark run <file-or-slug> --a <harness> --b <harness>` */
export async function benchmarkRunCommand(
  deps: CliDeps,
  target: string,
  flags: BenchmarkRunFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  if (!flags.a || !flags.b) {
    throw new CliError('--a <harness> and --b <harness> are both required (use "vanilla" for no harness).');
  }
  const entry = await resolvePackArg(deps, home, target);
  const agentId = flags.agent ?? DEFAULT_BENCHMARK_AGENT;
  const trust = flags.trust === true;
  const upload = flags.upload === undefined ? 'none' : parseUploadLevel(flags.upload);
  const privacy = { upload } as Partial<PrivacySettings>;
  const visibility: Visibility | undefined = flags.visibility ? parseVisibility(flags.visibility) : undefined;
  const trials = flags.trials === undefined ? undefined : parsePositiveInt(flags.trials, '--trials');

  const specs = expandBenchmark(entry.pack, entry.versionId, {
    a: competitorFor(flags.a, agentId, trust),
    b: competitorFor(flags.b, agentId, trust),
    ...(trials === undefined ? {} : { trials }),
    ...(flags.task ? { taskId: flags.task } : {}),
    ...(visibility ? { visibility } : {}),
    privacy: privacy as PrivacySettings,
  });

  const rows: BenchmarkRunRow[] = [];
  for (const [index, specInput] of specs.entries()) {
    const spec = parseSpec(specInput, 'the benchmark battle spec');
    if (!ui.json) {
      ui.status(
        'running ' +
          (spec.benchmark?.taskId ?? 'task') +
          ' trial ' +
          String(spec.benchmark?.trial ?? 1) +
          ' (' +
          String(index + 1) +
          '/' +
          String(specs.length) +
          ')',
      );
    }
    const outcome = await executeBattle(deps, ui, {
      spec,
      home,
      trust,
      localOnly: upload === 'none',
      open: false,
      quiet: true,
      ...(flags.server ? { serverUrl: flags.server } : {}),
    });
    rows.push(benchmarkRowFrom(outcome.record));
    if (deps.signal?.aborted) break;
  }

  const summary = summarizeBenchmarkRun(rows);
  const labels = { a: flags.a, b: flags.b };

  if (flags.markdown) {
    const file = path.resolve(deps.cwd(), flags.markdown);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, benchmarkMarkdown(entry.pack, entry.versionId, labels, rows, summary), 'utf8');
    if (!ui.json) ui.success('wrote ' + file);
  }

  if (ui.json) {
    ui.emitJson({
      pack: {
        slug: entry.pack.slug,
        name: entry.pack.name,
        version: entry.pack.version,
        versionId: entry.versionId,
        file: entry.file,
      },
      competitors: labels,
      agent: agentId,
      rows,
      summary,
    });
  } else {
    printRunTable(ui, labels, rows, summary);
  }

  if (summary.failed) {
    throw new CliError(
      String(summary.battles - summary.completed) +
        ' of ' +
        String(summary.battles) +
        ' battle(s) did not complete; the pack result is incomplete.',
      1,
    );
  }
}

// ---- registration ---------------------------------------------------------------------------------

function withJson(command: Command): Command {
  return command.option('--json', 'print machine-readable JSON on stdout (human lines go to stderr)');
}

function flagsOf<T>(command: Command): T {
  return command.optsWithGlobals() as T;
}

/** arena benchmark: list, show, validate, publish, run a pack. */
export function registerBenchmarkCommands(program: Command, deps: CliDeps): void {
  const benchmark = program
    .command('benchmark')
    .description('benchmark packs: reusable sets of tasks two harnesses can be run against');

  const list = benchmark
    .command('list')
    .description('benchmark packs on this machine, and on the server with --server')
    .option('--server [url]', 'also list the packs the server holds (needs `arena login`)')
    .option('--category <name>', 'only packs covering this category')
    .option('--limit <n>', 'how many to show (default 50)');
  withJson(list).action(async (_options: unknown, command: Command) => {
    await benchmarkListCommand(deps, flagsOf<BenchmarkListFlags>(command));
  });

  const show = benchmark
    .command('show')
    .description('what is in a pack: its tasks, categories, trials and version id')
    .argument('<pack>', 'path to a pack file, or the slug of a local or published pack')
    .option('--server <url>', 'Arena server')
    .option('--version <id>', 'a specific published version (bmv_…)');
  withJson(show).action(async (pack: string, _options: unknown, command: Command) => {
    await benchmarkShowCommand(deps, pack, flagsOf<BenchmarkShowFlags>(command));
  });

  const validate = benchmark
    .command('validate')
    .description('check a pack file and print the content version id it would publish as')
    .argument('<file>', 'path to a pack file (.yaml, .yml or .json)');
  withJson(validate).action(async (file: string, _options: unknown, command: Command) => {
    await benchmarkValidateCommand(deps, file, flagsOf<BenchmarkCommonFlags>(command));
  });

  const publish = benchmark
    .command('publish')
    .description('publish a pack version to the server (needs `arena login`)')
    .argument('<file>', 'path to a pack file')
    .option('--server <url>', 'Arena server');
  withJson(publish).action(async (file: string, _options: unknown, command: Command) => {
    await benchmarkPublishCommand(deps, file, flagsOf<BenchmarkPublishFlags>(command));
  });

  const run = benchmark
    .command('run')
    .description('run every task of a pack as a battle between two harnesses, on this machine')
    .argument('<pack>', 'path to a pack file, or the slug of a local pack')
    .requiredOption('--a <harness>', 'harness for side A ("vanilla", a GitHub URL, or a local path)')
    .requiredOption('--b <harness>', 'harness for side B')
    .option('--agent <id>', 'agent CLI for both sides (default ' + DEFAULT_BENCHMARK_AGENT + ')')
    .option('--trials <n>', "runs per task, replacing the pack's own trial count")
    .option('--task <id>', 'run one task of the pack instead of all of them')
    .option('--upload <level>', 'none | metrics | events | full (default none)')
    .option('--visibility <level>', 'private | unlisted | public for the uploaded battles')
    .option('--trust', 'approve harness install/prepare commands without asking')
    .option('--markdown <file>', 'also write the table as Markdown for a GitHub check')
    .option('--server <url>', 'Arena server for uploads');
  withJson(run).action(async (pack: string, _options: unknown, command: Command) => {
    await benchmarkRunCommand(deps, pack, flagsOf<BenchmarkRunFlags>(command));
  });
}
