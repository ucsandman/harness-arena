import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVENT_PROTOCOL_VERSION, emptyMetrics, makeId } from '@harness-arena/protocol';
import type {
  AdapterEvent,
  ArenaEvent,
  BattleRecord,
  BattleSpec,
  EvaluationReport,
  EventType,
  RunRecord,
  Side,
  Verdict,
} from '@harness-arena/protocol';
import type {
  AdapterCapabilities,
  AdapterRegistry,
  AdapterResult,
  AgentAdapter,
  Detection,
  ExecuteContext,
  Logger,
  PrepareContext,
  PreparedRun,
  ProcessRunner,
  StreamParser,
  ValidationResult,
} from '@harness-arena/adapters';
import type { EvaluationContext, ResolvedHarness, TestOutcome } from '../src/ports.js';

/** Shared fixtures for the core tests. Nothing here spawns a real agent CLI. */

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arena-' + prefix + '-'));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export function silentLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

export const FULL_CAPABILITIES: AdapterCapabilities = {
  tokens: 'observed',
  cost: 'observed',
  model: 'observed',
  toolCalls: 'observed',
  commands: 'observed',
  fileReads: 'observed',
  fileChanges: 'derived',
  subagents: 'observed',
  turns: 'observed',
  thinking: 'observed',
  contextCompaction: 'observed',
  userConfigIsolation: true,
  stdinPrompt: true,
  notes: [],
};

export function makeEvent(type: EventType, payload: unknown, extra: Partial<ArenaEvent> = {}): ArenaEvent {
  return {
    v: EVENT_PROTOCOL_VERSION,
    id: makeId('event'),
    battleId: 'btl_00000000000000aa',
    runId: 'run_00000000000000aa',
    side: 'a',
    seq: 1,
    ts: new Date(0).toISOString(),
    tOffsetMs: 0,
    source: { adapter: 'fake' },
    confidence: 'observed',
    type,
    payload,
    ...extra,
  } as ArenaEvent;
}

export interface FakeAdapterBehaviour {
  /** called inside execute(); write files here so the engine's git diff sees real changes */
  run?: (ctx: {
    workspace: string;
    emit: (event: AdapterEvent) => void;
    signal: AbortSignal;
  }) => Promise<AdapterResult | void>;
  capabilities?: Partial<AdapterCapabilities>;
  detection?: Partial<Detection>;
  validation?: Partial<ValidationResult>;
  id?: string;
}

const BASE_RESULT: AdapterResult = {
  status: 'completed',
  exitCode: 0,
  finalResponse: 'done',
  usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costUsd: 0.05 },
  model: 'fake-model-1',
  version: '9.9.9',
  turns: 3,
  errorCode: null,
  errorMessage: null,
  native: {},
};

/** A minimal in-test AgentAdapter, so the core suite never depends on @harness-arena/adapters. */
export function makeFakeAdapter(behaviour: FakeAdapterBehaviour = {}): AgentAdapter {
  const id = behaviour.id ?? 'fake';
  return {
    id,
    displayName: 'Fake Agent',
    kind: 'fake',
    binaryNames: ['fake-agent'],
    capabilities: () => ({ ...FULL_CAPABILITIES, ...behaviour.capabilities }),
    detect: async (): Promise<Detection> => ({
      id,
      installed: true,
      path: null,
      version: '9.9.9',
      auth: 'ok',
      notes: [],
      ...behaviour.detection,
    }),
    validate: async (): Promise<ValidationResult> => ({
      ok: true,
      problems: [],
      warnings: [],
      ...behaviour.validation,
    }),
    getVersion: async () => '9.9.9',
    prepare: async (ctx: PrepareContext): Promise<PreparedRun> => ({
      command: 'fake-agent',
      args: ['--headless', '--fixture', ctx.fixture ?? 'none'],
      env: { ARENA_FAKE: '1' },
      cwd: ctx.workspace,
      stdin: ctx.task.prompt,
      disclosure: {
        command: 'fake-agent',
        args: ['--headless', '--fixture', ctx.fixture ?? 'none'],
        envKeysAdded: ['ARENA_FAKE'],
        promptVia: 'stdin',
        notes: ['deterministic fake: no model is called'],
      },
      userConfigIsolated: true,
    }),
    execute: async (prepared: PreparedRun, ctx: ExecuteContext): Promise<AdapterResult> => {
      const custom = behaviour.run
        ? await behaviour.run({ workspace: prepared.cwd, emit: ctx.emit, signal: ctx.signal })
        : undefined;
      if (custom) return custom;
      return { ...BASE_RESULT };
    },
    cleanup: async () => {},
    createParser: (): StreamParser => ({
      feed: () => [],
      finish: () => ({ events: [], result: {} }),
    }),
  };
}

export function makeRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return {
    list: () => [...map.values()],
    get: (id) => map.get(id),
    register: (adapter) => {
      map.set(adapter.id, adapter);
    },
  };
}

export const neverRunner: ProcessRunner = {
  run: async () => {
    throw new Error('the core tests must never spawn a process through the ProcessRunner');
  },
};

export function makeTestOutcome(partial: Partial<TestOutcome> = {}): TestOutcome {
  return {
    exitCode: 0,
    passed: 3,
    failed: 0,
    skipped: 0,
    total: 3,
    durationMs: 120,
    parser: 'node-test',
    output: 'ok 3',
    failingTests: [],
    ...partial,
  };
}

export function fakeEvaluationReport(): EvaluationReport {
  return {
    results: [
      {
        evaluatorId: 'tests',
        kind: 'deterministic',
        side: 'a',
        status: 'passed',
        score: 1,
        summary: 'all tests pass',
        durationMs: 10,
      },
    ],
    comparisons: [],
    evidence: [{ label: 'Tests', a: 'pass', b: 'pass', favors: 'equal' }],
    unavailable: [],
    completedAt: new Date().toISOString(),
  };
}

export function fakeVerdict(winner: Verdict['winner'] = 'a'): Verdict {
  return {
    winner,
    confidence: 0.6,
    method: 'deterministic',
    reasons: ['side a passed the suite in fewer turns'],
    decisiveFactors: ['tests_passed'],
    caveats: ['one machine, one run'],
    judge: null,
  };
}

export function makeEvaluationContextAssertions(ctx: EvaluationContext): string[] {
  return [ctx.sides.a.workspace, ctx.sides.b.workspace];
}

export function makeResolvedHarness(name: string, dir: string | null): ResolvedHarness {
  return {
    name,
    kind: dir ? 'local' : 'vanilla',
    source: dir ? { kind: 'local', path: dir } : { kind: 'vanilla' },
    dir,
    commit: null,
    manifest: null,
    inspection: {
      source: dir ? { kind: 'local', path: dir } : { kind: 'vanilla' },
      commit: null,
      framework: 'claude-code',
      agents: ['fake'],
      manifest: { found: false, path: null, valid: false, errors: [], manifest: null },
      features: [],
      install: { packageManager: 'none', runtime: 'none', commands: [] },
      applyFiles: dir ? ['CLAUDE.md'] : [],
      compatibility: { status: 'ready', reasons: [] },
      fileCount: dir ? 1 : 0,
      truncated: false,
      inspectedAt: new Date().toISOString(),
    },
  };
}

/** A complete, schema-valid BattleRecord for the report/insight tests. */
export function makeRecord(overrides: {
  spec: BattleSpec;
  a?: Partial<RunRecord>;
  b?: Partial<RunRecord>;
  record?: Partial<BattleRecord>;
}): BattleRecord {
  const run = (side: Side, label: string, patch: Partial<RunRecord> = {}): RunRecord => ({
    id: makeId('run'),
    side,
    label,
    status: 'completed',
    agent: { id: 'fake', version: '9.9.9', model: 'fake-model-1', capabilities: { tokens: 'observed' } },
    harness: {
      name: side === 'a' ? 'ucsandman/agnostic-ai' : 'vanilla',
      source: side === 'a' ? 'https://github.com/ucsandman/agnostic-ai' : 'vanilla',
      kind: side === 'a' ? 'github' : 'vanilla',
      commit: null,
      manifest: null,
      appliedFiles: [],
      executedCommands: [],
    },
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1000).toISOString(),
    durationMs: 1000,
    exitCode: 0,
    metrics: emptyMetrics(),
    artifacts: { changedFiles: [] },
    error: null,
    eventCount: 0,
    invocation: { command: 'fake-agent', args: ['--headless'], envKeys: ['ARENA_FAKE'] },
    ...patch,
  });
  return {
    id: makeId('battle'),
    protocolVersion: 1,
    arenaVersion: '0.1.0-test',
    status: 'completed',
    spec: overrides.spec,
    task: { title: 'Fix the session-expiry bug', prompt: 'Fix it.', source: { kind: 'prompt' } },
    repository: { source: 'empty', kind: 'empty', commit: null, ref: null, dirty: null },
    environment: {
      os: { platform: 'linux', release: '6.0', arch: 'x64' },
      node: 'v24.0.0',
      git: '2.45.0',
      arenaVersion: '0.1.0-test',
      ci: false,
      cpuCount: 8,
      memoryGb: 32,
      agents: { fake: { version: '9.9.9', userConfigIsolated: true } },
      sharedFlags: {},
      recordedAt: new Date(0).toISOString(),
    },
    runs: { a: run('a', 'Agnostic AI', overrides.a), b: run('b', 'Vanilla Claude Code', overrides.b) },
    evaluation: null,
    verdict: null,
    insights: [],
    verification: { kind: 'local', eligible: false, sandbox: null },
    demo: false,
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(2000).toISOString(),
    error: null,
    ...overrides.record,
  };
}
