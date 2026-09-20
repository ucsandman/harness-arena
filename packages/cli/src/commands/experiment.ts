import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import {
  componentKindSchema,
  experimentKindSchema,
  experimentSchema,
  type BattleRecord,
  type BattleSpecInput,
  type ChangedComponent,
  type CompetitorRef,
  type Experiment,
  type ExperimentKind,
  type ExperimentSummary,
  type HarnessRef,
  type WorkTarget,
} from '@harness-arena/protocol';
import {
  expandBenchmark,
  newExperimentId,
  saveExperimentRunRecord,
  loadExperimentRunRecord,
  listExperimentRunRecords,
  type ExperimentBattleRef,
  type ExperimentRunRecordInput,
} from '@harness-arena/core';
import { computeExperimentSummary } from '@harness-arena/evaluator';
import type { CliDeps } from '../deps.js';
import { createUi, formatMetric, shortDate } from '../ui.js';
import type { Ui } from '../ui.js';
import { resolveHome } from '../config.js';
import { parsePositiveInt, parseSpec, parseUploadLevel, parseVisibility, readSpecFile } from '../spec.js';
import { executeBattle } from '../runner.js';
import { getJson, serverError } from './login.js';
import { listSpecFiles } from './regression.js';
import {
  DEFAULT_BENCHMARK_AGENT,
  competitorFor,
  postJson,
  resolvePackArg,
  serverSession,
} from './benchmark.js';
import { CliError } from '../errors.js';

/**
 * `arena experiment` — control vs treatment, over the same tasks, with the arithmetic attached.
 *
 * Control always runs as side A and treatment as side B, so every battle is one paired observation.
 * The summary is computed locally from the records this machine just produced (the same pure function
 * the server uses), so an experiment is complete offline; uploading only adds a page other people can
 * read. Nothing here proves anything on its own: the summary labels its own evidence strength, and a
 * single trial is labelled `none`.
 */

export interface ExperimentRunFlags {
  kind?: string;
  control?: string;
  treatment?: string;
  benchmark?: string;
  specDir?: string;
  agent?: string;
  trials?: string;
  task?: string;
  component?: string;
  title?: string;
  upload?: string;
  visibility?: string;
  trust?: boolean;
  markdown?: string;
  server?: string;
  json?: boolean;
  home?: string;
}

export interface ExperimentShowFlags {
  server?: string;
  json?: boolean;
  home?: string;
}

export interface CompareFlags extends Omit<ExperimentRunFlags, 'kind' | 'control' | 'treatment'> {
  from?: string;
  to?: string;
}

/** `source@commit` — a bare source means "whatever that ref resolves to now". */
export function parseHarnessRef(value: string, flag: string): HarnessRef {
  const text = value.trim();
  if (text.length === 0) throw new CliError(flag + ' needs a harness ("vanilla", a GitHub URL, or a path)');
  const at = text.lastIndexOf('@');
  // a scheme or a scp-style git URL also contains '@', so only a trailing sha-looking part counts
  if (at > 0) {
    const commit = text.slice(at + 1);
    if (/^[0-9a-f]{7,40}$/i.test(commit)) {
      return { source: text.slice(0, at), commit: commit.toLowerCase(), trusted: false };
    }
  }
  return { source: text, trusted: false };
}

export function parseComponent(value: string): ChangedComponent {
  const [rawKind, ...rest] = value.split(':');
  const name = rest.join(':').trim();
  const kind = componentKindSchema.safeParse((rawKind ?? '').trim().toLowerCase());
  if (!kind.success || name.length === 0) {
    throw new CliError(
      '--component must look like <kind>:<name>, e.g. skill:code-review. Kinds: ' +
        componentKindSchema.options.join(', '),
    );
  }
  return { kind: kind.data, name };
}

function competitorRef(ref: HarnessRef, label: string): CompetitorRef {
  return { label, harness: ref };
}

function describeRef(ref: HarnessRef): string {
  return ref.commit ? ref.source + '@' + ref.commit.slice(0, 7) : ref.source;
}

// ---- printing ------------------------------------------------------------------------------------

function percent(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value * 100)) + '%';
}

function signedPercent(value: number | null): string {
  if (value === null) return 'n/a';
  const rounded = Math.round(value * 100);
  return (rounded > 0 ? '+' : '') + String(rounded) + '%';
}

export function experimentSummaryMarkdown(
  title: string,
  control: string,
  treatment: string,
  summary: ExperimentSummary,
): string {
  const lines: string[] = [];
  lines.push('## Experiment: ' + title);
  lines.push('');
  lines.push('Control `' + control + '` vs treatment `' + treatment + '`');
  lines.push('');
  lines.push('| Measure | Control | Treatment | Change |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    '| Correctness | ' +
      percent(summary.correctness.control.rate) +
      ' | ' +
      percent(summary.correctness.treatment.rate) +
      ' | ' +
      (summary.correctness.deltaPoints === null
        ? 'n/a'
        : (summary.correctness.deltaPoints > 0 ? '+' : '') +
          String(Math.round(summary.correctness.deltaPoints)) +
          ' points') +
      ' |',
  );
  for (const [label, delta] of [
    ['Tokens (mean)', summary.tokens],
    ['Cost (mean)', summary.cost],
    ['Duration (mean)', summary.duration],
  ] as const) {
    lines.push(
      '| ' +
        label +
        ' | ' +
        (delta.control.mean === null ? 'n/a' : String(Math.round(delta.control.mean))) +
        ' | ' +
        (delta.treatment.mean === null ? 'n/a' : String(Math.round(delta.treatment.mean))) +
        ' | ' +
        signedPercent(delta.deltaPercent) +
        ' |',
    );
  }
  lines.push('');
  lines.push(
    'Battles: ' +
      String(summary.battles) +
      ' decided, ' +
      String(summary.comparable) +
      ' comparable. Evidence: ' +
      summary.evidence.level +
      ' — ' +
      summary.evidence.rationale,
  );
  lines.push('');
  for (const conclusion of summary.conclusions) lines.push('- ' + conclusion);
  lines.push('');
  return lines.join('\n');
}

export function printExperimentSummary(
  ui: Ui,
  labels: { control: string; treatment: string },
  summary: ExperimentSummary,
): void {
  ui.line();
  ui.table(
    [
      [
        'Correctness',
        percent(summary.correctness.control.rate),
        percent(summary.correctness.treatment.rate),
        summary.correctness.deltaPoints === null
          ? 'n/a'
          : (summary.correctness.deltaPoints > 0 ? '+' : '') +
            String(Math.round(summary.correctness.deltaPoints)) +
            ' pts',
      ],
      [
        'Tokens (mean)',
        summary.tokens.control.mean === null ? 'n/a' : String(Math.round(summary.tokens.control.mean)),
        summary.tokens.treatment.mean === null ? 'n/a' : String(Math.round(summary.tokens.treatment.mean)),
        signedPercent(summary.tokens.deltaPercent),
      ],
      [
        'Cost (mean)',
        summary.cost.control.mean === null
          ? 'n/a'
          : formatMetric('cost_usd', { value: summary.cost.control.mean, status: 'calculated' }),
        summary.cost.treatment.mean === null
          ? 'n/a'
          : formatMetric('cost_usd', { value: summary.cost.treatment.mean, status: 'calculated' }),
        signedPercent(summary.cost.deltaPercent),
      ],
      [
        'Duration (mean)',
        summary.duration.control.mean === null
          ? 'n/a'
          : formatMetric('duration_ms', { value: summary.duration.control.mean, status: 'calculated' }),
        summary.duration.treatment.mean === null
          ? 'n/a'
          : formatMetric('duration_ms', { value: summary.duration.treatment.mean, status: 'calculated' }),
        signedPercent(summary.duration.deltaPercent),
      ],
    ],
    ['Measure', labels.control, labels.treatment, 'Change'],
  );
  ui.line();
  ui.line(
    ui.c.bold(
      'Wins: treatment ' +
        String(summary.wins.treatment) +
        ' / control ' +
        String(summary.wins.control) +
        ' / ties ' +
        String(summary.wins.ties) +
        ' / inconclusive ' +
        String(summary.wins.inconclusive),
    ),
  );
  ui.line(
    String(summary.battles) +
      ' decided battle(s), ' +
      String(summary.comparable) +
      ' comparable. Evidence: ' +
      summary.evidence.level,
  );
  ui.line(ui.c.dim('  ' + summary.evidence.rationale));
  ui.heading('What the numbers say');
  for (const conclusion of summary.conclusions) ui.line('  ' + ui.sym.dot + ' ' + conclusion);
}

// ---- run ------------------------------------------------------------------------------------------

interface PreparedWork {
  specs: BattleSpecInput[];
  target: WorkTarget | null;
  benchmark: { slug: string; versionId: string; version: string; name: string } | null;
  specDir: string | null;
}

/** The battles this experiment will run: a pack expanded, or a directory of specs re-pointed. */
async function prepareWork(
  deps: CliDeps,
  home: string,
  flags: ExperimentRunFlags,
  control: HarnessRef,
  treatment: HarnessRef,
  agentId: string,
  trials: number | undefined,
): Promise<PreparedWork> {
  const trust = flags.trust === true;
  const upload = flags.upload === undefined ? 'none' : parseUploadLevel(flags.upload);
  const visibility = flags.visibility ? parseVisibility(flags.visibility) : undefined;

  const a = {
    ...competitorFor(control.source, agentId, trust),
    label: 'control',
    harness: { ...control, trusted: trust },
  };
  const b = {
    ...competitorFor(treatment.source, agentId, trust),
    label: 'treatment',
    harness: { ...treatment, trusted: trust },
  };

  if (flags.benchmark) {
    const entry = await resolvePackArg(deps, home, flags.benchmark);
    const specs = expandBenchmark(entry.pack, entry.versionId, {
      a,
      b,
      ...(trials === undefined ? {} : { trials }),
      ...(flags.task ? { taskId: flags.task } : {}),
      ...(visibility ? { visibility } : {}),
      privacy: { upload, exclude: [], redact: true },
    });
    return {
      specs,
      target: {
        kind: 'benchmark',
        slug: entry.pack.slug,
        versionId: entry.versionId,
        ...(flags.task ? { taskId: flags.task } : {}),
      },
      benchmark: {
        slug: entry.pack.slug,
        versionId: entry.versionId,
        version: entry.pack.version,
        name: entry.pack.name,
      },
      specDir: null,
    };
  }

  const dir = path.resolve(deps.cwd(), flags.specDir as string);
  const files = listSpecFiles(dir);
  const specs: BattleSpecInput[] = [];
  for (const file of files) {
    const base = parseSpec(readSpecFile(file, deps.cwd()), path.basename(file));
    for (let trial = 1; trial <= (trials ?? 1); trial++) {
      specs.push({
        ...base,
        title:
          (base.title ?? path.basename(file)) +
          (trials && trials > 1 ? ' (trial ' + String(trial) + ')' : ''),
        competitors: { a, b },
        privacy: { ...base.privacy, upload },
        ...(visibility ? { visibility } : {}),
      });
    }
  }
  return { specs, target: null, benchmark: null, specDir: dir };
}

async function createServerExperiment(
  deps: CliDeps,
  ui: Ui,
  session: { serverUrl: string; token: string },
  body: unknown,
): Promise<{ experiment: Experiment; url: string } | null> {
  const result = await postJson(deps, session.serverUrl + '/api/v1/experiments', body, session.token);
  if (result.status < 200 || result.status >= 300) {
    ui.warn(
      serverError(result.status, result.json, 'could not create the experiment on ' + session.serverUrl)
        .message + '; the run continues locally',
    );
    return null;
  }
  const payload = result.json as { experiment?: unknown; url?: string };
  const parsed = experimentSchema.safeParse(payload.experiment);
  if (!parsed.success) {
    ui.warn('the server returned an unexpected experiment; the run continues locally');
    return null;
  }
  return {
    experiment: parsed.data,
    url: payload.url ?? session.serverUrl + '/experiments/' + parsed.data.id,
  };
}

/** `arena experiment run` */
export async function experimentRunCommand(deps: CliDeps, flags: ExperimentRunFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);

  const kindParsed = experimentKindSchema.safeParse((flags.kind ?? 'comparison').trim().toLowerCase());
  if (!kindParsed.success) {
    throw new CliError('--kind must be regression, ablation or comparison, got: ' + String(flags.kind));
  }
  const kind: ExperimentKind = kindParsed.data;
  if (!flags.control || !flags.treatment) {
    throw new CliError('--control <harness> and --treatment <harness> are both required.');
  }
  if (!flags.benchmark && !flags.specDir) {
    throw new CliError('give the work to run: --benchmark <file-or-slug> or --spec-dir <dir>.');
  }
  if (flags.benchmark && flags.specDir) {
    throw new CliError('--benchmark and --spec-dir are mutually exclusive.');
  }

  const control = parseHarnessRef(flags.control, '--control');
  const treatment = parseHarnessRef(flags.treatment, '--treatment');
  const changedComponent = flags.component ? parseComponent(flags.component) : null;
  if (kind === 'ablation' && !changedComponent) {
    throw new CliError('an ablation must name what changed: --component <kind>:<name>.');
  }
  const agentId = flags.agent ?? DEFAULT_BENCHMARK_AGENT;
  const trials = flags.trials === undefined ? undefined : parsePositiveInt(flags.trials, '--trials');
  const upload = flags.upload === undefined ? 'none' : parseUploadLevel(flags.upload);
  const visibility = flags.visibility ? parseVisibility(flags.visibility) : 'private';
  const title =
    flags.title ??
    kind.charAt(0).toUpperCase() +
      kind.slice(1) +
      ': ' +
      describeRef(treatment) +
      ' vs ' +
      describeRef(control);

  const work = await prepareWork(deps, home, flags, control, treatment, agentId, trials);
  if (work.specs.length === 0) throw new CliError('there is nothing to run: the pack or directory is empty.');

  // The server copy is optional. It is created before the first battle so every battle can carry the
  // experiment id in spec.arena, which is what lets the server verify the link later.
  let server: { serverUrl: string; token: string } | null = null;
  let created: { experiment: Experiment; url: string } | null = null;
  if (upload !== 'none') {
    const session = await serverSession(deps, home, flags.server);
    if (!session.token) {
      ui.warn('not logged in, so nothing is uploaded: run `arena login` or drop --upload.');
    } else if (!work.target) {
      ui.warn('a --spec-dir experiment has no publishable target, so it stays on this machine.');
    } else {
      server = { serverUrl: session.serverUrl, token: session.token };
      created = await createServerExperiment(deps, ui, server, {
        title,
        kind,
        control: competitorRef(control, 'control'),
        treatment: competitorRef(treatment, 'treatment'),
        ...(changedComponent ? { changedComponent } : {}),
        agent: { id: agentId },
        target: work.target,
        trials: trials ?? 1,
        visibility,
      });
      if (!created) server = null;
    }
  }

  const experimentId = created?.experiment.id ?? newExperimentId();
  const records: BattleRecord[] = [];
  const battleRefs: ExperimentBattleRef[] = [];

  for (const [index, specInput] of work.specs.entries()) {
    const spec = parseSpec(
      created
        ? { ...specInput, arena: { ...(specInput.arena ?? {}), experimentId: created.experiment.id } }
        : specInput,
      'the experiment battle spec',
    );
    if (!ui.json) {
      ui.status(
        'running ' +
          (spec.benchmark?.taskId ?? spec.title ?? 'battle') +
          ' (' +
          String(index + 1) +
          '/' +
          String(work.specs.length) +
          ')',
      );
    }
    const outcome = await executeBattle(deps, ui, {
      spec,
      home,
      trust: flags.trust === true,
      localOnly: upload === 'none',
      open: false,
      quiet: true,
      ...(flags.server ? { serverUrl: flags.server } : {}),
    });
    records.push(outcome.record);
    const ref: ExperimentBattleRef = {
      battleId: outcome.record.id,
      treatmentSide: 'b',
      taskId: spec.benchmark?.taskId ?? null,
      trial: spec.benchmark?.trial ?? 1,
      status: outcome.record.status,
      winner: outcome.record.verdict?.winner ?? null,
      uploaded: outcome.url !== null,
      url: outcome.url,
    };
    battleRefs.push(ref);

    if (server && created && outcome.url !== null) {
      const link = await postJson(
        deps,
        server.serverUrl + '/api/v1/experiments/' + created.experiment.id + '/battles',
        { battleId: outcome.record.id, treatmentSide: 'b' },
        server.token,
      );
      if (link.status < 200 || link.status >= 300) {
        ui.warn(
          serverError(
            link.status,
            link.json,
            'could not link battle ' + outcome.record.id + ' to the experiment',
          ).message,
        );
      }
    }
    if (deps.signal?.aborted) break;
  }

  // The summary never needs the server: it is computed from the records this machine just produced.
  const summary = computeExperimentSummary(
    records.map((record) => ({ record, treatmentSide: 'b' as const })),
  );

  if (server && created) {
    const finalize = await postJson(
      deps,
      server.serverUrl + '/api/v1/experiments/' + created.experiment.id + '/finalize',
      {},
      server.token,
    );
    if (finalize.status < 200 || finalize.status >= 300) {
      ui.warn(
        serverError(finalize.status, finalize.json, 'could not finalize the experiment on the server')
          .message,
      );
    }
  }

  const record: ExperimentRunRecordInput = {
    version: 1,
    id: experimentId,
    title,
    kind,
    status: 'completed',
    control: competitorRef(control, 'control'),
    treatment: competitorRef(treatment, 'treatment'),
    changedComponent,
    agent: { id: agentId as ExperimentRunRecordInput['agent']['id'] },
    benchmark: work.benchmark,
    specDir: work.specDir,
    trials: trials ?? 1,
    battles: battleRefs,
    summary,
    server: created ? { url: server?.serverUrl ?? '', experimentUrl: created.url } : null,
    createdAt: new Date(deps.now()).toISOString(),
    completedAt: new Date(deps.now()).toISOString(),
  };
  const file = await saveExperimentRunRecord(home, record);

  if (flags.markdown) {
    const target = path.resolve(deps.cwd(), flags.markdown);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      experimentSummaryMarkdown(title, describeRef(control), describeRef(treatment), summary),
      'utf8',
    );
    if (!ui.json) ui.success('wrote ' + target);
  }

  if (ui.json) {
    ui.emitJson({
      id: experimentId,
      title,
      kind,
      control: describeRef(control),
      treatment: describeRef(treatment),
      battles: battleRefs,
      summary,
      file,
      url: created?.url ?? null,
    });
  } else {
    ui.heading(title);
    ui.detail('Control', describeRef(control));
    ui.detail('Treatment', describeRef(treatment));
    if (changedComponent) ui.detail('Changed', changedComponent.kind + ':' + changedComponent.name);
    printExperimentSummary(ui, { control: 'control', treatment: 'treatment' }, summary);
    ui.line();
    ui.detail('Record', file);
    if (created) ui.detail('Web', created.url);
    ui.detail('Experiment', experimentId);
  }

  if (summary.battles === 0) {
    throw new CliError('no battle reached a verdict, so this experiment measured nothing.', 1);
  }
}

/** `arena experiment show <id>` — the local record when this machine ran it, else the server. */
export async function experimentShowCommand(
  deps: CliDeps,
  id: string,
  flags: ExperimentShowFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const local = await loadExperimentRunRecord(home, id);
  if (local) {
    if (ui.json) {
      ui.emitJson(local);
      return;
    }
    ui.heading(local.title);
    ui.detail('Id', local.id);
    ui.detail('Kind', local.kind);
    ui.detail('Control', local.control.harness.source);
    ui.detail('Treatment', local.treatment.harness.source);
    if (local.benchmark) ui.detail('Benchmark', local.benchmark.slug + ' ' + local.benchmark.versionId);
    ui.detail('Battles', String(local.battles.length));
    ui.detail('Ran', shortDate(local.createdAt));
    if (local.summary)
      printExperimentSummary(ui, { control: 'control', treatment: 'treatment' }, local.summary);
    return;
  }

  const session = await serverSession(deps, home, flags.server);
  if (!session.token) {
    throw new CliError(
      'no local experiment ' + id + ' on this machine, and reading one from the server needs `arena login`.',
    );
  }
  const result = await getJson(
    deps,
    session.serverUrl + '/api/v1/experiments/' + encodeURIComponent(id),
    session.token,
  );
  if (result.status === 404) throw new CliError('no experiment ' + id + ' is visible to you');
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not read the experiment from ' + session.serverUrl);
  }
  const payload = result.json as { experiment?: unknown; url?: string };
  const parsed = experimentSchema.safeParse(payload.experiment);
  if (!parsed.success) throw new CliError('the server returned an unexpected experiment response');
  const experiment = parsed.data;
  if (ui.json) {
    ui.emitJson({ experiment, url: payload.url ?? null });
    return;
  }
  ui.heading(experiment.title);
  ui.detail('Id', experiment.id);
  ui.detail('Kind', experiment.kind);
  ui.detail('Status', experiment.status);
  ui.detail('Control', experiment.control.harness.source);
  ui.detail('Treatment', experiment.treatment.harness.source);
  ui.detail('Battles', String(experiment.battleIds.length));
  if (payload.url) ui.detail('Web', payload.url);
  if (experiment.summary) {
    printExperimentSummary(ui, { control: 'control', treatment: 'treatment' }, experiment.summary);
  }
}

/** `arena experiment list` — what this machine has run. */
export async function experimentListCommand(
  deps: CliDeps,
  flags: { json?: boolean; home?: string; limit?: string },
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const limit = flags.limit === undefined ? 20 : parsePositiveInt(flags.limit, '--limit');
  const records = await listExperimentRunRecords(home, limit);
  if (ui.json) {
    ui.emitJson({ home, count: records.length, experiments: records });
    return;
  }
  if (records.length === 0) {
    ui.line('No experiments under ' + home + ' yet. Run `arena experiment run --help` to start one.');
    return;
  }
  ui.table(
    records.map((record) => [
      record.id,
      record.kind,
      String(record.battles.length),
      record.summary ? record.summary.evidence.level : '-',
      shortDate(record.createdAt),
      record.title,
    ]),
    ['Id', 'Kind', 'Battles', 'Evidence', 'Ran', 'Title'],
  );
}

/** `arena compare <harness> --from <commit> --to <commit>` — sugar for a regression experiment. */
export async function compareCommand(deps: CliDeps, harness: string, flags: CompareFlags): Promise<void> {
  if (!flags.from || !flags.to) {
    throw new CliError('`arena compare` needs --from <commit> and --to <commit>.');
  }
  await experimentRunCommand(deps, {
    ...flags,
    kind: 'regression',
    control: harness + '@' + flags.from,
    treatment: harness + '@' + flags.to,
  });
}

// ---- registration ---------------------------------------------------------------------------------

function withJson(command: Command): Command {
  return command.option('--json', 'print machine-readable JSON on stdout (human lines go to stderr)');
}

function flagsOf<T>(command: Command): T {
  return command.optsWithGlobals() as T;
}

function addWorkOptions(command: Command): Command {
  return command
    .option('--benchmark <pack>', 'benchmark pack file or the slug of a local pack')
    .option('--spec-dir <dir>', 'directory of *.json battle specs to use instead of a pack')
    .option('--task <id>', 'run one task of the pack')
    .option('--agent <id>', 'agent CLI for both sides (default ' + DEFAULT_BENCHMARK_AGENT + ')')
    .option('--trials <n>', 'runs per task (default: what the pack says)')
    .option('--title <text>', 'title for the experiment')
    .option('--upload <level>', 'none | metrics | events | full (default none)')
    .option('--visibility <level>', 'private | unlisted | public for the uploaded battles')
    .option('--trust', 'approve harness install/prepare commands without asking')
    .option('--markdown <file>', 'also write the summary as Markdown')
    .option('--server <url>', 'Arena server');
}

/** arena experiment: run a regression/ablation/comparison over a pack; arena compare. */
export function registerExperimentCommands(program: Command, deps: CliDeps): void {
  const experiment = program
    .command('experiment')
    .description('control vs treatment over the same tasks, with the statistics attached');

  const run = addWorkOptions(
    experiment
      .command('run')
      .description('run every task with control as side A and treatment as side B, then summarize')
      .requiredOption('--kind <kind>', 'regression | ablation | comparison')
      .requiredOption('--control <harness>', 'control harness, optionally harness@commit')
      .requiredOption('--treatment <harness>', 'treatment harness, optionally harness@commit')
      .option('--component <kind:name>', 'the one component that differs (required for an ablation)'),
  );
  withJson(run).action(async (_options: unknown, command: Command) => {
    await experimentRunCommand(deps, flagsOf<ExperimentRunFlags>(command));
  });

  const show = experiment
    .command('show')
    .description('an experiment this machine ran, or one from the server')
    .argument('<id>', 'experiment id (exp_…)')
    .option('--server <url>', 'Arena server');
  withJson(show).action(async (id: string, _options: unknown, command: Command) => {
    await experimentShowCommand(deps, id, flagsOf<ExperimentShowFlags>(command));
  });

  const list = experiment
    .command('list')
    .description('experiments this machine has run')
    .option('--limit <n>', 'how many to show (default 20)');
  withJson(list).action(async (_options: unknown, command: Command) => {
    await experimentListCommand(deps, flagsOf<{ json?: boolean; home?: string; limit?: string }>(command));
  });

  const compare = addWorkOptions(
    program
      .command('compare')
      .description('did this harness get better between two commits? (a regression experiment)')
      .argument('<harness>', 'harness source: a GitHub URL or a local path')
      .requiredOption('--from <commit>', 'the commit that is the control')
      .requiredOption('--to <commit>', 'the commit that is the treatment'),
  );
  withJson(compare).action(async (harness: string, _options: unknown, command: Command) => {
    await compareCommand(deps, harness, flagsOf<CompareFlags>(command));
  });
}
