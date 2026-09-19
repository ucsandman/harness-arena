import type {
  AdapterEvent,
  BattleSpec,
  BattleSpecInput,
  EvaluationReport,
  EvaluatorResult,
  ResolvedTask,
  RunMetrics,
  Side,
} from '@harness-arena/protocol';
import { battleSpecSchema, emptyMetrics } from '@harness-arena/protocol';
import type {
  EvaluationContext,
  JudgeRunner,
  ProcessRunner,
  ProcessRunResult,
  SideContext,
} from '../src/index.js';
import { makeSideContext, silentLogger } from '../src/index.js';

export interface FakeRunCall {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  stdin: string | null;
  env: Record<string, string>;
}

export interface FakeRunSpec {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  spawnError?: string | null;
}

export type FakeRunner = ProcessRunner & { calls: FakeRunCall[] };

/** A ProcessRunner that never spawns anything: it replays canned lines and records what it was asked. */
export function fakeRunner(
  responder: FakeRunSpec | ((call: FakeRunCall, index: number) => FakeRunSpec),
): FakeRunner {
  const calls: FakeRunCall[] = [];
  return {
    calls,
    async run(opts) {
      const call: FakeRunCall = {
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
        stdin: opts.stdin,
        env: opts.env,
      };
      calls.push(call);
      const spec = typeof responder === 'function' ? responder(call, calls.length - 1) : responder;
      for (const line of spec.stdout ?? []) opts.onStdoutLine(line);
      for (const line of spec.stderr ?? []) opts.onStderrLine(line);
      const result: ProcessRunResult = {
        exitCode: spec.exitCode === undefined ? 0 : spec.exitCode,
        signal: null,
        timedOut: spec.timedOut ?? false,
        aborted: spec.aborted ?? false,
        outputBytes: 0,
        truncated: false,
        durationMs: spec.durationMs ?? 5,
        spawnError: spec.spawnError ?? null,
      };
      return result;
    },
  };
}

export function makeSpec(overrides: Partial<BattleSpecInput> = {}): BattleSpec {
  return battleSpecSchema.parse({
    version: 1,
    task: { kind: 'prompt', prompt: 'Fix the failing test in src/math.ts', title: 'Fix math' },
    repository: { source: '.' },
    competitors: {
      a: { label: 'Side one', agent: { id: 'fake' }, harness: { source: 'vanilla' } },
      b: { label: 'Side two', agent: { id: 'fake' }, harness: { source: 'vanilla' } },
    },
    ...overrides,
  });
}

export const demoTask: ResolvedTask = {
  title: 'Fix math',
  prompt: 'Fix the failing test in src/math.ts',
  source: { kind: 'prompt' },
};

export interface MadeContext {
  ctx: EvaluationContext;
  events: Array<{ side: Side | null; event: AdapterEvent }>;
}

export function makeCtx(
  opts: {
    spec?: BattleSpec;
    task?: ResolvedTask;
    a?: Partial<SideContext>;
    b?: Partial<SideContext>;
    runner?: ProcessRunner;
    judge?: JudgeRunner;
    signal?: AbortSignal;
  } = {},
): MadeContext {
  const events: Array<{ side: Side | null; event: AdapterEvent }> = [];
  const ctx: EvaluationContext = {
    spec: opts.spec ?? makeSpec(),
    task: opts.task ?? demoTask,
    sides: { a: makeSideContext(opts.a), b: makeSideContext(opts.b) },
    runner: opts.runner ?? fakeRunner({}),
    logger: silentLogger,
    emit: (side, event) => events.push({ side, event }),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.judge ? { judge: opts.judge } : {}),
  };
  return { ctx, events };
}

export function metricsWith(
  values: Partial<Record<keyof RunMetrics, RunMetrics[keyof RunMetrics]>>,
): RunMetrics {
  const metrics = emptyMetrics();
  for (const [key, value] of Object.entries(values)) {
    if (value) metrics[key as keyof RunMetrics] = value;
  }
  return metrics;
}

export function makeReport(
  results: EvaluatorResult[],
  extra: Partial<EvaluationReport> = {},
): EvaluationReport {
  return {
    results,
    comparisons: [],
    evidence: [],
    unavailable: [],
    completedAt: '2026-09-19T00:00:00.000Z',
    ...extra,
  };
}

export function testsResult(
  side: Side,
  details: Record<string, unknown>,
  status: EvaluatorResult['status'],
): EvaluatorResult {
  return {
    evaluatorId: 'repo-tests',
    kind: 'deterministic',
    side,
    status,
    score: null,
    summary: 'tests',
    details,
    durationMs: 1,
  };
}

export function assertionsResult(side: Side, passed: number, total: number): EvaluatorResult {
  return {
    evaluatorId: 'assertions',
    kind: 'deterministic',
    side,
    status: passed === total ? 'passed' : 'failed',
    score: total ? passed / total : null,
    summary: `${passed}/${total} assertions passed`,
    details: {
      passed,
      failed: total - passed,
      total,
      checks: Array.from({ length: total }, (_, i) => ({
        index: i,
        type: 'file-exists',
        label: `assertion ${i + 1}`,
        passed: i < passed,
        detail: '',
      })),
    },
    durationMs: 1,
  };
}

export function buildResult(side: Side, ok: number, total: number): EvaluatorResult {
  return {
    evaluatorId: 'build-checks',
    kind: 'deterministic',
    side,
    status: ok === total ? 'passed' : 'failed',
    score: total ? ok / total : null,
    summary: `${ok}/${total} checks passed`,
    details: {
      ok,
      total,
      checks: Array.from({ length: total }, (_, i) => ({
        kind: i === 0 ? 'build' : 'lint',
        command: `check ${i}`,
        exitCode: i < ok ? 0 : 1,
        ok: i < ok,
        durationMs: 1,
        timedOut: false,
      })),
    },
    durationMs: 1,
  };
}

export function judgeResult(winner: 'a' | 'b' | 'tie', confidence = 0.6): EvaluatorResult {
  return {
    evaluatorId: 'judge',
    kind: 'subjective',
    side: null,
    status: 'passed',
    score: null,
    summary: 'judge',
    details: {
      winner,
      confidence,
      rationale: 'cleaner change',
      blind: true,
      subjective: true,
      judgeAgent: 'fake',
      judgeModel: null,
    },
    durationMs: 1,
  };
}
