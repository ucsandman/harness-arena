import fs from 'node:fs';
import path from 'node:path';
import { battleSpecSchema, emptyMetrics, makeId, PROTOCOL_VERSION } from '@harness-arena/protocol';
import type {
  AdapterEvent,
  AgentConfig,
  ArenaEvent,
  BattleRecord,
  BattleSpec,
  BattleSpecInput,
  BattleStatus,
  CompetitorSpec,
  HarnessRef,
  HarnessSource,
  ResolvedTask,
  RunRecord,
  Side,
} from '@harness-arena/protocol';
import type {
  AdapterRegistry,
  AdapterResult,
  Detection,
  Logger,
  ProcessRunner,
} from '@harness-arena/adapters';
import { ARENA_VERSION } from './version.js';
import { createLogger, createSilentLogger } from './logger.js';
import { collectSecretEnvValues, createPassthroughRedactor, createRedactor } from './redact.js';
import { createStateStore } from './store.js';
import type { StateStore } from './store.js';
import {
  createWorktree,
  diffStats,
  ensureMirror,
  initEmptyRepo,
  isDirty,
  isGitRepo,
  isLocalSource,
  removeWorktree,
  resolveCommit,
} from './git.js';
import type { DiffStats } from './git.js';
import { createEventBus } from './events.js';
import { collectEnvironment } from './environment.js';
import { aggregateRunMetrics } from './metrics.js';
import { computeInsights } from './insights.js';
import { buildReportBundle, renderReportHtml } from './report/html.js';
import { loadAdapters, loadEvaluator, loadHarness } from './deps.js';
import type { Uploader } from './upload.js';
import type {
  ApplyHarnessFn,
  DecideVerdictFn,
  DescribeExecutionFn,
  EvaluateBattleFn,
  HarnessExecution,
  ResolveHarnessFn,
  ResolveIssueFn,
  ResolvedHarness,
  RunTestsFn,
  JudgeRunner,
  TestOutcome,
} from './ports.js';

/**
 * The battle engine. One entry point, one record, one event log.
 *
 * Guarantees the rest of the product relies on:
 *  - the user's checkout is never written to; every run works in an Arena-owned git worktree;
 *  - both sides get the same commit, the same task text, the same limits and the same evaluation;
 *  - a failure or an abort still produces a saved record, an event log and a report;
 *  - nothing is fabricated: a metric the CLI cannot report stays `unavailable`.
 *
 * runBattle rejects only when the spec itself is invalid or ARENA_HOME is unusable. Every other
 * failure comes back as a saved record with `status: 'failed'` and `record.error` set.
 */

const SIDES: readonly Side[] = ['a', 'b'];

export interface RunBattleDeps {
  resolveHarness?: ResolveHarnessFn;
  applyHarness?: ApplyHarnessFn;
  describeExecution?: DescribeExecutionFn;
  runTests?: RunTestsFn;
  evaluateBattle?: EvaluateBattleFn;
  decideVerdict?: DecideVerdictFn;
  resolveIssue?: ResolveIssueFn;
}

export interface RunBattleOptions {
  home?: string;
  registry?: AdapterRegistry;
  logger?: Logger;
  signal?: AbortSignal;
  onEvent?: (event: ArenaEvent) => void;
  onStatus?: (status: BattleStatus, detail?: string) => void;
  /** asked once per harness that wants to run commands; returning false fails the battle */
  trust?: (harness: ResolvedHarness, exec: HarnessExecution) => Promise<boolean>;
  uploader?: Uploader | null;
  demo?: boolean;
  now?: () => number;
  /** fake adapter only: replay fixtures with their recorded delays */
  realtimeFake?: boolean;
  keepWorkspaces?: boolean;
  deps?: RunBattleDeps;
  runner?: ProcessRunner;
  /** optional blind LLM judge, passed through to the evaluator and always labelled subjective */
  judge?: JudgeRunner;
  env?: Record<string, string | undefined>;
}

// ---- source helpers ---------------------------------------------------------------------------

function harnessKindOf(source: string): ResolvedHarness['kind'] {
  if (source.trim() === 'vanilla') return 'vanilla';
  if (isLocalSource(source)) return 'local';
  return /github\.com/i.test(source) ? 'github' : 'git';
}

function repositoryKindOf(source: string): BattleRecord['repository']['kind'] {
  if (source.trim() === 'empty') return 'empty';
  if (isLocalSource(source)) return 'local';
  return /github\.com/i.test(source) ? 'github' : 'git';
}

function githubParts(source: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:$|[/#?])/.exec(source.trim());
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

function harnessDisplayName(source: string): string {
  const trimmed = source.trim();
  if (trimmed === 'vanilla') return 'vanilla';
  const gh = githubParts(trimmed);
  if (gh) return gh.owner + '/' + gh.repo;
  if (isLocalSource(trimmed)) return path.basename(path.resolve(trimmed)) || trimmed;
  return trimmed;
}

/** Enough of a HarnessSource for display. The harness package does the real parsing. */
function shallowHarnessSource(source: string): HarnessSource {
  const trimmed = source.trim();
  if (trimmed === 'vanilla') return { kind: 'vanilla' };
  const gh = githubParts(trimmed);
  if (gh) return { kind: 'github', url: trimmed, owner: gh.owner, repo: gh.repo, ref: null, path: null };
  if (isLocalSource(trimmed)) return { kind: 'local', path: path.resolve(trimmed) };
  return { kind: 'git', url: trimmed, ref: null };
}

/**
 * A harness that is shown but never fetched: `vanilla` (nothing to fetch) and demo battles (which
 * must not touch the network). Keeps the declared source and name so the report reads correctly.
 */
function stubHarness(ref: HarnessRef, reason: string): ResolvedHarness {
  const kind = harnessKindOf(ref.source);
  const source = shallowHarnessSource(ref.source);
  return {
    name: harnessDisplayName(ref.source),
    kind,
    source,
    dir: null,
    commit: null,
    manifest: null,
    inspection: {
      source,
      commit: null,
      framework: 'unknown',
      agents: [],
      manifest: { found: false, path: null, valid: false, errors: [], manifest: null },
      features: [],
      install: { packageManager: 'none', runtime: 'none', commands: [] },
      applyFiles: [],
      compatibility: { status: 'ready', reasons: [reason] },
      fileCount: 0,
      truncated: false,
      inspectedAt: new Date().toISOString(),
    },
  };
}

function competitorLabel(competitor: CompetitorSpec): string {
  if (competitor.label) return competitor.label;
  return competitor.agent.id + ' + ' + harnessDisplayName(competitor.harness.source);
}

function firstLine(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? 'Battle';
  const trimmed = line.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

// ---- issue resolution -------------------------------------------------------------------------

/** GitHub issue -> prompt. Read-only, unauthenticated unless GITHUB_TOKEN is present. */
async function resolveIssueViaGitHub(
  input: { repo: string; number: number; instructions?: string },
  opts: { token?: string; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<ResolvedTask> {
  const [owner, name] = input.repo.split('/');
  const url = 'https://api.github.com/repos/' + owner + '/' + name + '/issues/' + input.number;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'harness-arena/' + ARENA_VERSION,
    'x-github-api-version': '2022-11-28',
  };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const response = await fetchImpl(url, { headers, signal: opts.signal });
  if (!response.ok) {
    throw new Error(
      'could not read ' + input.repo + '#' + input.number + ' from GitHub (status ' + response.status + ')',
    );
  }
  const issue = (await response.json()) as { title?: string; body?: string | null; html_url?: string };
  const title = issue.title ?? input.repo + '#' + input.number;
  const body = (issue.body ?? '').trim();
  const prompt = [
    '# ' + title,
    '',
    body.length > 0 ? body : '(the issue has no description)',
    '',
    '---',
    '',
    input.instructions?.trim() ||
      'Resolve this issue in the repository you have been given. Change only what the issue requires.',
  ].join('\n');
  return {
    title,
    prompt,
    source: { kind: 'issue', repo: input.repo, number: input.number, url: issue.html_url ?? url },
  };
}

// ---- record scaffolding -----------------------------------------------------------------------

function emptyRunRecord(spec: BattleSpec, side: Side): RunRecord {
  const competitor = spec.competitors[side];
  return {
    id: makeId('run'),
    side,
    label: competitorLabel(competitor),
    status: 'pending',
    agent: {
      id: competitor.agent.id,
      version: null,
      model: competitor.agent.model ?? null,
      capabilities: {},
    },
    harness: {
      name: harnessDisplayName(competitor.harness.source),
      source: competitor.harness.source,
      kind: harnessKindOf(competitor.harness.source),
      commit: null,
      manifest: null,
      appliedFiles: [],
      executedCommands: [],
    },
    startedAt: null,
    completedAt: null,
    durationMs: null,
    exitCode: null,
    metrics: emptyMetrics(),
    artifacts: { changedFiles: [] },
    error: null,
    eventCount: 0,
    invocation: null,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- the engine -------------------------------------------------------------------------------

export async function runBattle(input: BattleSpecInput, opts: RunBattleOptions = {}): Promise<BattleRecord> {
  const parsedSpec = battleSpecSchema.safeParse(input);
  if (!parsedSpec.success) {
    const detail = parsedSpec.error.issues
      .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
      .join('; ');
    throw new Error('invalid battle spec: ' + detail);
  }
  const spec = parsedSpec.data;
  const demo = opts.demo === true;
  const now = opts.now ?? (() => Date.now());
  const env = opts.env ?? process.env;
  const store: StateStore = createStateStore(opts.home);
  const home = store.home;
  const battleId = makeId('battle');
  const paths = store.paths(battleId);
  const startedAtMs = now();
  const logger = opts.logger ?? createSilentLogger();
  const log = logger.child({ battleId });

  // Secrets: the user's own environment plus anything the spec adds for the agents.
  const specEnvValues = SIDES.flatMap((s) => Object.values(spec.competitors[s].agent.env ?? {}));
  const redactor = spec.privacy.redact
    ? createRedactor({
        envValues: [...collectSecretEnvValues(env), ...specEnvValues.filter((v) => v.length >= 8)],
      })
    : createPassthroughRedactor();

  fs.mkdirSync(paths.logs, { recursive: true });
  const engineLog = createLogger({
    level: 'debug',
    file: path.join(paths.logs, 'engine.ndjson'),
    redactor,
    bindings: { battleId },
  });
  const both: Logger = {
    debug: (m, d) => {
      log.debug(m, d);
      engineLog.debug(m, d);
    },
    info: (m, d) => {
      log.info(m, d);
      engineLog.info(m, d);
    },
    warn: (m, d) => {
      log.warn(m, d);
      engineLog.warn(m, d);
    },
    error: (m, d) => {
      log.error(m, d);
      engineLog.error(m, d);
    },
    child: (b) => log.child(b),
  };

  const pendingEvents: ArenaEvent[] = [];
  const allEvents: ArenaEvent[] = [];
  const bus = createEventBus({
    battleId,
    startedAt: startedAtMs,
    redactor,
    privacy: spec.privacy,
    sink: (event) => {
      pendingEvents.push(event);
      allEvents.push(event);
    },
    onEvent: opts.onEvent,
    now,
  });

  const runIds: Record<Side, string> = { a: '', b: '' };
  const emit = (side: Side | null, adapterId: string, event: AdapterEvent) =>
    bus.emit(side, side ? runIds[side] : null, adapterId, event);

  const record: BattleRecord = {
    id: battleId,
    protocolVersion: PROTOCOL_VERSION,
    arenaVersion: ARENA_VERSION,
    status: 'pending',
    spec,
    task: { title: spec.title ?? 'Battle', prompt: '', source: demo ? { kind: 'demo' } : { kind: 'prompt' } },
    repository: {
      source: spec.repository.source,
      kind: repositoryKindOf(spec.repository.source),
      commit: null,
      ref: spec.repository.ref ?? null,
      dirty: null,
    },
    environment: await collectEnvironment({ detections: [], arenaVersion: ARENA_VERSION, home }),
    runs: { a: emptyRunRecord(spec, 'a'), b: emptyRunRecord(spec, 'b') },
    evaluation: null,
    verdict: null,
    insights: [],
    verification: demo
      ? { kind: 'local', eligible: false, sandbox: null }
      : { kind: 'local', eligible: false, sandbox: null },
    demo,
    createdAt: new Date(startedAtMs).toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
  };
  runIds.a = record.runs.a.id;
  runIds.b = record.runs.b.id;

  // The prompt is required by the schema, so a placeholder stands in until the task resolves.
  record.task.prompt = '(resolving the task)';

  const flushEvents = async (): Promise<void> => {
    const batch = pendingEvents.splice(0, pendingEvents.length);
    if (batch.length === 0) return;
    try {
      await store.appendEvents(battleId, batch);
    } catch (err) {
      both.warn('could not append events', { reason: errorText(err) });
    }
    if (opts.uploader) void opts.uploader.pushEvents(battleId, batch);
  };

  const setStatus = async (status: BattleStatus, detail?: string): Promise<void> => {
    record.status = status;
    opts.onStatus?.(status, detail);
    both.info('battle status', { status, ...(detail ? { detail } : {}) });
    await save();
  };

  const save = async (): Promise<void> => {
    for (const side of SIDES) {
      record.runs[side].eventCount = allEvents.filter((e) => e.side === side).length;
    }
    await flushEvents();
    await store.saveRecord(record);
  };

  const lock = await store.lock(battleId);
  const mirrors = new Set<string>();
  const workspaceRoots: Partial<Record<Side, string>> = {};
  const startCommits: Record<Side, string | null> = { a: null, b: null };
  const mirrorForWorktree: Partial<Record<Side, string>> = {};
  let cancelled = false;

  try {
    await store.saveRecord(record);

    emit(null, 'arena', {
      type: 'battle.started',
      at: startedAtMs,
      confidence: 'derived',
      payload: {
        title: spec.title ?? firstLine(spec.task.kind === 'prompt' ? spec.task.prompt : spec.task.repo),
        a: {
          label: record.runs.a.label,
          agent: spec.competitors.a.agent.id,
          harness: record.runs.a.harness.name,
        },
        b: {
          label: record.runs.b.label,
          agent: spec.competitors.b.agent.id,
          harness: record.runs.b.harness.name,
        },
        mode: spec.mode,
        demo,
      },
    });

    // ---- task ----------------------------------------------------------------------------------
    if (spec.task.kind === 'prompt') {
      record.task = {
        title: spec.task.title ?? spec.title ?? firstLine(spec.task.prompt),
        prompt: spec.task.prompt,
        source: demo ? { kind: 'demo' } : { kind: 'prompt' },
      };
    } else {
      const resolveIssue = opts.deps?.resolveIssue ?? resolveIssueViaGitHub;
      record.task = await resolveIssue(
        { repo: spec.task.repo, number: spec.task.number, instructions: spec.task.instructions },
        { token: env.GITHUB_TOKEN ?? env.GH_TOKEN, signal: opts.signal },
      );
    }
    record.startedAt = new Date(startedAtMs).toISOString();
    await save();

    // ---- repository ----------------------------------------------------------------------------
    const repoIsEmpty = spec.repository.source.trim() === 'empty';
    let mirror: string | null = null;
    if (!repoIsEmpty) {
      const source = spec.repository.source;
      if (isLocalSource(source)) {
        const abs = path.resolve(source);
        if (!(await isGitRepo(abs, { home }))) {
          throw new Error('not a git repository: ' + abs);
        }
        const dirty = await isDirty(abs, { home });
        record.repository.dirty = dirty;
        if (dirty) {
          both.warn('the source checkout has uncommitted changes; the battle uses the last commit', {});
          emit(null, 'arena', {
            type: 'warning',
            confidence: 'derived',
            payload: {
              code: 'dirty_checkout',
              message: 'The source checkout has uncommitted changes. Both runs start from the last commit.',
            },
          });
        }
      }
      mirror = await ensureMirror({ home, source, signal: opts.signal });
      mirrors.add(mirror);
      record.repository.commit = await resolveCommit(mirror, spec.repository.ref, {
        home,
        signal: opts.signal,
      });
      startCommits.a = record.repository.commit;
      startCommits.b = record.repository.commit;
      await save();
    }

    // ---- adapters ------------------------------------------------------------------------------
    const registry = opts.registry ?? (await loadAdapters()).createRegistry();
    if (opts.realtimeFake && !opts.registry) {
      const { FakeAdapter } = await loadAdapters();
      registry.register(new FakeAdapter({ realtime: true }));
    }
    const runner = opts.runner ?? (await loadAdapters()).defaultProcessRunner;

    const adapters = {} as Record<Side, ReturnType<AdapterRegistry['get']>>;
    const detections: Detection[] = [];
    for (const side of SIDES) {
      const agentId = spec.competitors[side].agent.id;
      const adapter = registry.get(agentId);
      if (!adapter) {
        throw new Error(
          'no adapter for agent "' +
            agentId +
            '"; known agents: ' +
            registry
              .list()
              .map((a) => a.id)
              .join(', '),
        );
      }
      const detection = await adapter.detect(env);
      if (!detection.installed) {
        throw new Error(
          'the ' +
            adapter.displayName +
            ' CLI was not found on PATH (looked for: ' +
            adapter.binaryNames.join(', ') +
            '). Install it and sign in, then run the battle again.',
        );
      }
      const validation = await adapter.validate(detection);
      if (!validation.ok) {
        throw new Error(adapter.displayName + ' cannot run this battle: ' + validation.problems.join('; '));
      }
      for (const warning of validation.warnings) {
        emit(side, adapter.id, {
          type: 'warning',
          confidence: 'derived',
          payload: { code: 'agent', message: warning },
        });
      }
      adapters[side] = adapter;
      if (!detections.some((d) => d.id === detection.id)) detections.push(detection);
      record.runs[side].agent.version = detection.version;
      record.runs[side].agent.capabilities = Object.fromEntries(
        Object.entries(adapter.capabilities()).filter(
          ([, v]) => v === 'observed' || v === 'derived' || v === 'unavailable',
        ),
      ) as RunRecord['agent']['capabilities'];
    }
    record.environment = await collectEnvironment({
      registry,
      detections,
      arenaVersion: ARENA_VERSION,
      home,
      env,
    });
    await save();

    // ---- harnesses -----------------------------------------------------------------------------
    const describeExecution: DescribeExecutionFn =
      opts.deps?.describeExecution ??
      ((h) => ({ commands: h.inspection.install.commands, files: h.inspection.applyFiles }));
    const harnesses = {} as Record<Side, ResolvedHarness>;
    for (const side of SIDES) {
      const ref = spec.competitors[side].harness;
      if (ref.source.trim() === 'vanilla') {
        harnesses[side] = stubHarness(ref, 'vanilla: the agent runs with its own defaults');
      } else if (demo) {
        harnesses[side] = stubHarness(ref, 'demo: the harness is shown but never fetched');
      } else {
        const resolveHarness = opts.deps?.resolveHarness ?? (await loadHarness()).resolveHarness;
        harnesses[side] = await resolveHarness(ref, {
          home,
          agentId: spec.competitors[side].agent.id,
          logger: both,
        });
      }
      const harness = harnesses[side];
      const exec = describeExecution(harness);
      if (exec.commands.length > 0 && !ref.trusted) {
        const approved = opts.trust ? await opts.trust(harness, exec) : false;
        if (!approved) {
          throw new Error(
            'harness "' +
              harness.name +
              '" wants to run ' +
              exec.commands.length +
              ' command(s) on this machine (' +
              exec.commands.join(' && ') +
              '). Re-run with the harness trusted to allow it.',
          );
        }
      }
      record.runs[side].harness = {
        name: harness.name,
        source: ref.source,
        kind: harness.kind,
        commit: harness.commit,
        manifest: harness.manifest,
        appliedFiles: [],
        executedCommands: [],
      };
    }
    await save();

    // ---- prepare workspaces --------------------------------------------------------------------
    await setStatus('preparing');
    const baselines: Record<Side, TestOutcome | null> = { a: null, b: null };
    const runTests: RunTestsFn | null = spec.evaluation.tests
      ? (opts.deps?.runTests ?? (await loadEvaluator()).runTests)
      : null;
    const applyHarness: ApplyHarnessFn | null = SIDES.some((s) => harnesses[s].dir !== null)
      ? (opts.deps?.applyHarness ?? (await loadHarness()).applyHarness)
      : null;
    const agentConfigs: Record<Side, AgentConfig | null> = { a: null, b: null };

    for (const side of SIDES) {
      throwIfAborted(opts.signal);
      const root = paths.workspaces[side];
      fs.mkdirSync(path.dirname(root), { recursive: true });
      if (repoIsEmpty) {
        startCommits[side] = await initEmptyRepo(root, { home, signal: opts.signal });
      } else if (mirror) {
        await createWorktree({
          mirror,
          commit: record.repository.commit as string,
          dest: root,
          submodules: spec.repository.submodules,
          home,
          signal: opts.signal,
        });
        mirrorForWorktree[side] = mirror;
      }
      workspaceRoots[side] = root;

      const harness = harnesses[side];
      if (harness.dir !== null && applyHarness) {
        const applied = await applyHarness(harness, {
          workspace: root,
          agentId: spec.competitors[side].agent.id,
          trusted: spec.competitors[side].harness.trusted || Boolean(opts.trust),
          runner,
          env: Object.fromEntries(
            Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'),
          ),
          logger: both,
          signal: opts.signal,
        });
        record.runs[side].harness.appliedFiles = applied.appliedFiles;
        record.runs[side].harness.executedCommands = applied.executedCommands;
        agentConfigs[side] = applied.agentConfig;
      }

      if (runTests && spec.evaluation.tests?.baseline) {
        const tests = spec.evaluation.tests;
        emit(side, 'arena', {
          type: 'test.started',
          confidence: 'derived',
          payload: { command: tests.command, phase: 'baseline' },
        });
        const outcome = await runTests({
          command: tests.command,
          cwd: root,
          parser: tests.parser,
          timeoutMs: tests.timeoutMs,
          runner,
          signal: opts.signal,
        });
        baselines[side] = outcome;
        emit(side, 'arena', {
          type: 'test.completed',
          confidence: 'derived',
          payload: {
            command: tests.command,
            phase: 'baseline',
            exitCode: outcome.exitCode,
            passed: outcome.passed,
            failed: outcome.failed,
            skipped: outcome.skipped,
            total: outcome.total,
            durationMs: outcome.durationMs,
            parser: outcome.parser,
          },
        });
      }
      record.runs[side].status = 'preparing';
      await save();
    }

    // ---- execute -------------------------------------------------------------------------------
    await setStatus('running');
    const diffs: Record<Side, DiffStats | null> = { a: null, b: null };
    const postTests: Record<Side, TestOutcome | null> = { a: null, b: null };
    const finalResponses: Record<Side, string | null> = { a: null, b: null };

    const executeSide = async (side: Side): Promise<void> => {
      const run = record.runs[side];
      const adapter = adapters[side];
      if (!adapter) return;
      const root = workspaceRoots[side] as string;
      const cwd = spec.repository.subdir ? path.join(root, spec.repository.subdir) : root;
      const rawLog = fs.createWriteStream(paths.rawLogs[side], { flags: 'a' });
      const controller = new AbortController();
      let timedOut = false;
      let interrupted = false;
      const onOuterAbort = () => {
        interrupted = true;
        controller.abort();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        emit(side, adapter.id, {
          type: 'limit.hit',
          confidence: 'derived',
          payload: { kind: 'timeout', detail: 'the run exceeded ' + spec.limits.timeoutMs + ' ms' },
        });
        emit(side, adapter.id, { type: 'interrupt', confidence: 'derived', payload: { reason: 'timeout' } });
        controller.abort();
      }, spec.limits.timeoutMs);

      if (opts.signal) {
        if (opts.signal.aborted) onOuterAbort();
        else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
      }

      const startedAt = now();
      run.startedAt = new Date(startedAt).toISOString();
      run.status = 'running';
      let result: AdapterResult | null = null;
      try {
        const prepared = await adapter.prepare({
          runId: run.id,
          side,
          workspace: cwd,
          harnessDir: harnesses[side].dir,
          agentConfig: agentConfigs[side],
          agent: spec.competitors[side].agent,
          fixture: spec.competitors[side].fixture ?? null,
          task: record.task,
          limits: spec.limits,
          env,
          logger: both.child({ side, agent: adapter.id }),
        });
        run.invocation = {
          command: prepared.disclosure.command,
          args: prepared.disclosure.args,
          envKeys: prepared.disclosure.envKeysAdded,
        };
        run.artifacts.rawLogPath = paths.rawLogs[side];
        await save();

        emit(side, adapter.id, {
          type: 'run.started',
          at: startedAt,
          confidence: 'derived',
          payload: {
            side,
            agent: adapter.id,
            agentVersion: run.agent.version,
            model: run.agent.model,
            harness: harnesses[side].name,
            harnessCommit: harnesses[side].commit,
            ...(spec.privacy.exclude.includes('paths') ? {} : { workspace: root }),
          },
        });

        result = await adapter.execute(prepared, {
          emit: (event) => {
            emit(side, adapter.id, event);
          },
          signal: controller.signal,
          logger: both.child({ side, agent: adapter.id }),
          limits: spec.limits,
          runner,
          onRawLine: (stream, line) => {
            rawLog.write(stream + ' ' + line + '\n');
          },
        });
        run.exitCode = result.exitCode;
        run.status = timedOut
          ? 'timed_out'
          : interrupted
            ? 'interrupted'
            : result.status === 'completed'
              ? 'completed'
              : result.status === 'timed_out'
                ? 'timed_out'
                : result.status === 'interrupted'
                  ? 'interrupted'
                  : 'failed';
        if (result.version) run.agent.version = result.version;
        if (result.model) run.agent.model = result.model;
        finalResponses[side] = result.finalResponse;
        run.artifacts.finalResponse = result.finalResponse;
        if (result.errorMessage) {
          run.error = { code: result.errorCode ?? 'agent_error', message: result.errorMessage };
          emit(side, adapter.id, {
            type: 'error',
            confidence: 'observed',
            payload: { code: result.errorCode ?? 'agent_error', message: result.errorMessage, fatal: false },
          });
        }
      } catch (err) {
        run.status = interrupted ? 'interrupted' : timedOut ? 'timed_out' : 'failed';
        run.error = { code: 'run_failed', message: errorText(err) };
        both.error('run failed', { side, reason: errorText(err) });
        emit(side, adapter.id, {
          type: 'error',
          confidence: 'derived',
          payload: { code: 'run_failed', message: errorText(err), fatal: true },
        });
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onOuterAbort);
        await new Promise<void>((resolve) => rawLog.end(resolve));
      }

      const wallClockMs = Math.max(0, now() - startedAt);
      // A fake replay reports its simulated timeline; real CLI runs are measured by the wall clock.
      run.durationMs = typeof result?.durationMs === 'number' ? Math.max(0, result.durationMs) : wallClockMs;
      const completedAt = startedAt + run.durationMs;
      run.completedAt = new Date(completedAt).toISOString();

      // Collect the change set even for a failed or interrupted run: it is the most valuable artifact.
      try {
        diffs[side] = await diffStats(root, startCommits[side], { home });
        const diff = diffs[side] as DiffStats;
        run.artifacts.changedFiles = diff.files.map((f) => ({
          path: f.path,
          kind: f.kind,
          linesAdded: f.linesAdded,
          linesRemoved: f.linesRemoved,
        }));
        if (!spec.privacy.exclude.includes('diffs')) {
          run.artifacts.diff = diff.diff;
          run.artifacts.diffBytes = diff.diffBytes;
        }
        for (const file of diff.files) {
          emit(side, 'arena', {
            type: 'file.changed',
            confidence: 'derived',
            payload: {
              path: file.path,
              kind: file.kind,
              linesAdded: file.linesAdded,
              linesRemoved: file.linesRemoved,
            },
          });
        }
      } catch (err) {
        both.warn('could not collect the diff', { side, reason: errorText(err) });
      }

      if (runTests && spec.evaluation.tests) {
        const tests = spec.evaluation.tests;
        try {
          emit(side, 'arena', {
            type: 'test.started',
            confidence: 'derived',
            payload: { command: tests.command, phase: 'post' },
          });
          const outcome = await runTests({
            command: tests.command,
            cwd,
            parser: tests.parser,
            timeoutMs: tests.timeoutMs,
            runner,
          });
          postTests[side] = outcome;
          emit(side, 'arena', {
            type: 'test.completed',
            confidence: 'derived',
            payload: {
              command: tests.command,
              phase: 'post',
              exitCode: outcome.exitCode,
              passed: outcome.passed,
              failed: outcome.failed,
              skipped: outcome.skipped,
              total: outcome.total,
              durationMs: outcome.durationMs,
              parser: outcome.parser,
            },
          });
        } catch (err) {
          both.warn('the post-run test command failed to execute', { side, reason: errorText(err) });
        }
      }

      run.metrics = aggregateRunMetrics({
        events: allEvents.filter((e) => e.side === side),
        adapterResult: result,
        capabilities: adapter.capabilities(),
        diff: diffs[side],
        tests: { baseline: baselines[side], post: postTests[side] },
        status: run.status,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        agentId: adapter.id,
      });

      emit(side, adapter.id, {
        type: 'run.completed',
        at: completedAt,
        confidence: 'derived',
        payload: {
          side,
          status: run.status,
          exitCode: run.exitCode,
          durationMs: run.durationMs,
          ...(run.error ? { reason: run.error.message } : {}),
        },
      });
      await save();
    };

    if (spec.parallel) {
      await Promise.all(SIDES.map((side) => executeSide(side)));
    } else {
      for (const side of SIDES) await executeSide(side);
    }

    const sharedFlags: Record<string, string[]> = {};
    for (const side of SIDES) {
      const invocation = record.runs[side].invocation;
      if (invocation) sharedFlags[record.runs[side].agent.id] = invocation.args;
    }
    record.environment = { ...record.environment, sharedFlags };

    cancelled = opts.signal?.aborted === true;

    // ---- evaluate ------------------------------------------------------------------------------
    if (!cancelled) {
      await setStatus('evaluating');
      try {
        const evaluateBattle: EvaluateBattleFn =
          opts.deps?.evaluateBattle ?? (await loadEvaluator()).evaluateBattle;
        const decideVerdict: DecideVerdictFn =
          opts.deps?.decideVerdict ?? (await loadEvaluator()).decideVerdict;
        record.evaluation = await evaluateBattle({
          spec,
          task: record.task,
          sides: {
            a: {
              workspace: workspaceRoots.a as string,
              startCommit: startCommits.a,
              status: record.runs.a.status,
              metrics: record.runs.a.metrics,
              artifacts: record.runs.a.artifacts,
              finalResponse: finalResponses.a,
              baseline: baselines.a,
            },
            b: {
              workspace: workspaceRoots.b as string,
              startCommit: startCommits.b,
              status: record.runs.b.status,
              metrics: record.runs.b.metrics,
              artifacts: record.runs.b.artifacts,
              finalResponse: finalResponses.b,
              baseline: baselines.b,
            },
          },
          runner,
          logger: both,
          emit: (side, event) => {
            emit(side, 'arena', event);
          },
          signal: opts.signal,
          ...(opts.judge ? { judge: opts.judge } : {}),
        });
        record.verdict = decideVerdict(record.evaluation, {
          a: { status: record.runs.a.status, metrics: record.runs.a.metrics },
          b: { status: record.runs.b.status, metrics: record.runs.b.metrics },
        });
      } catch (err) {
        both.error('evaluation failed', { reason: errorText(err) });
        record.error = 'evaluation failed: ' + errorText(err);
        emit(null, 'arena', {
          type: 'error',
          confidence: 'derived',
          payload: { code: 'evaluation_failed', message: errorText(err), fatal: false },
        });
      }
    }

    record.insights = computeInsights(record, allEvents);

    if (cancelled) {
      for (const side of SIDES) {
        if (record.runs[side].status === 'pending' || record.runs[side].status === 'running') {
          record.runs[side].status = 'interrupted';
        }
      }
      await setStatus('cancelled', 'the battle was cancelled');
    } else {
      const failedBoth = SIDES.every((s) => record.runs[s].status === 'failed');
      await setStatus(failedBoth ? 'failed' : 'completed');
      if (failedBoth && !record.error) record.error = 'both runs failed; see the per-run errors';
    }
  } catch (err) {
    const aborted = opts.signal?.aborted === true;
    record.error = errorText(err);
    for (const side of SIDES) {
      if (
        record.runs[side].status === 'pending' ||
        record.runs[side].status === 'preparing' ||
        record.runs[side].status === 'running'
      ) {
        record.runs[side].status = aborted ? 'interrupted' : 'failed';
      }
    }
    both.error('battle failed', { reason: errorText(err) });
    emit(null, 'arena', {
      type: 'error',
      confidence: 'derived',
      payload: { code: 'battle_failed', message: errorText(err), fatal: true },
    });
    record.insights = computeInsights(record, allEvents);
    cancelled = aborted;
    record.status = aborted ? 'cancelled' : 'failed';
    opts.onStatus?.(record.status, record.error);
  } finally {
    const battleEndMs = Math.max(
      now(),
      ...Object.values(record.runs).map((r) => (r.completedAt ? Date.parse(r.completedAt) : 0)),
    );
    record.completedAt = new Date(battleEndMs).toISOString();
    emit(null, 'arena', {
      type: 'battle.completed',
      at: battleEndMs,
      confidence: 'derived',
      payload: {
        status: record.status,
        ...(record.verdict ? { winner: record.verdict.winner } : {}),
        durationMs: Math.max(0, battleEndMs - startedAtMs),
      },
    });

    try {
      await save();
    } catch (err) {
      both.error('could not save the battle record', { reason: errorText(err) });
    }

    // The report is written even for a failed or cancelled battle: the data is already paid for.
    try {
      const bundle = buildReportBundle(record, allEvents, ARENA_VERSION);
      fs.writeFileSync(paths.report, renderReportHtml(bundle), 'utf8');
    } catch (err) {
      both.error('could not write the report', { reason: errorText(err) });
    }

    if (opts.uploader) {
      try {
        await opts.uploader.patchRecord(battleId, record);
        for (const side of SIDES) {
          const diff = record.runs[side].artifacts.diff;
          if (diff) await opts.uploader.uploadArtifact(battleId, side, 'diff', diff);
          const final = record.runs[side].artifacts.finalResponse;
          if (final) await opts.uploader.uploadArtifact(battleId, side, 'final_response', final);
        }
        await opts.uploader.flush();
      } catch (err) {
        both.warn('upload finished with errors', { reason: errorText(err) });
      }
    }

    if (!opts.keepWorkspaces) {
      for (const side of SIDES) {
        const root = workspaceRoots[side];
        if (!root) continue;
        try {
          const owner = mirrorForWorktree[side];
          if (owner) await removeWorktree({ mirror: owner, dest: root, home });
          else fs.rmSync(root, { recursive: true, force: true });
        } catch (err) {
          both.warn('could not remove a workspace', { side, reason: errorText(err) });
        }
      }
    }

    await lock.release();
  }

  return record;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('the battle was cancelled');
}
