import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyMetrics,
  makeId,
  type AgentId,
  type BattleRecord,
  type BattleSpec,
  type BattleSpecInput,
  type MetricKey,
  type MetricValue,
  type RunStatus,
  type Side,
} from '@harness-arena/protocol';
import { battleSpecSchema } from '@harness-arena/protocol';
import type { AdapterCapabilities, AdapterRegistry, AgentAdapter, Detection } from '@harness-arena/adapters';
import type { RunBattleOptions } from '@harness-arena/core';
import { ARENA_VERSION, createStateStore } from '@harness-arena/core';
import type { CliDeps, Prompter } from '../src/deps.js';

/** Shared fakes for the CLI tests. Nothing here spawns a CLI, touches the network, or writes to ~. */

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arena-cli-' + prefix + '-'));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

const CAPABILITIES: AdapterCapabilities = {
  tokens: 'observed',
  cost: 'observed',
  model: 'observed',
  toolCalls: 'observed',
  commands: 'observed',
  fileReads: 'observed',
  fileChanges: 'observed',
  subagents: 'unavailable',
  turns: 'observed',
  thinking: 'unavailable',
  contextCompaction: 'unavailable',
  userConfigIsolation: true,
  stdinPrompt: true,
  notes: ['test adapter'],
};

export interface StubAdapterOptions {
  id: string;
  displayName?: string;
  installed?: boolean;
  version?: string | null;
  auth?: Detection['auth'];
}

/** An adapter that only answers detection questions: enough for every CLI code path. */
export function stubAdapter(opts: StubAdapterOptions): AgentAdapter {
  const detection: Detection = {
    id: opts.id as AgentId,
    installed: opts.installed !== false,
    path: opts.installed === false ? null : '/usr/local/bin/' + opts.id,
    version: opts.version ?? '1.2.3',
    auth: opts.auth ?? 'ok',
    notes: [],
  };
  return {
    id: opts.id as AgentId,
    displayName: opts.displayName ?? opts.id,
    kind: 'cli',
    binaryNames: [opts.id],
    capabilities: () => CAPABILITIES,
    detect: async () => detection,
    validate: async () => ({ ok: true, problems: [], warnings: [] }),
    getVersion: async () => detection.version,
    prepare: async () => {
      throw new Error('the stub adapter never runs');
    },
    execute: async () => {
      throw new Error('the stub adapter never runs');
    },
    cleanup: async () => {},
    createParser: () => ({ feed: () => [], finish: () => ({ events: [], result: {} }) }),
  };
}

export function stubRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id),
    register: (adapter) => {
      byId.set(adapter.id, adapter);
    },
  };
}

export function metric(value: number, status: MetricValue['status'] = 'observed'): MetricValue {
  return { value, status, source: 'test' };
}

export interface RecordOptions {
  id?: string;
  status?: BattleRecord['status'];
  statusA?: RunStatus;
  statusB?: RunStatus;
  metricsA?: Partial<Record<MetricKey, MetricValue>>;
  metricsB?: Partial<Record<MetricKey, MetricValue>>;
  durationA?: number | null;
  durationB?: number | null;
  winner?: 'a' | 'b' | 'tie' | 'inconclusive' | null;
  spec?: BattleSpec;
}

export function fakeSpec(overrides: Partial<BattleSpecInput> = {}): BattleSpec {
  return battleSpecSchema.parse({
    version: 1,
    title: 'Test battle',
    task: { kind: 'prompt', prompt: 'Fix the bug.' },
    repository: { source: 'empty' },
    competitors: {
      a: { label: 'A side', agent: { id: 'fake' }, harness: { source: 'vanilla' } },
      b: { label: 'B side', agent: { id: 'fake' }, harness: { source: 'vanilla' } },
    },
    privacy: { upload: 'none' },
    ...overrides,
  } satisfies BattleSpecInput);
}

export function fakeRecord(opts: RecordOptions = {}): BattleRecord {
  const spec = opts.spec ?? fakeSpec();
  const run = (
    side: Side,
    status: RunStatus,
    metrics: Partial<Record<MetricKey, MetricValue>>,
    duration: number | null,
  ) => ({
    id: makeId('run'),
    side,
    label: spec.competitors[side].label ?? side,
    status,
    agent: {
      id: spec.competitors[side].agent.id,
      version: '1.2.3',
      model: null,
      capabilities: {} as Record<string, 'observed' | 'derived' | 'unavailable'>,
    },
    harness: {
      name: spec.competitors[side].harness.source,
      source: spec.competitors[side].harness.source,
      kind: 'vanilla' as const,
      commit: null,
      manifest: null,
      appliedFiles: [],
      executedCommands: [],
      skippedFiles: [],
    },
    startedAt: '2026-09-19T12:00:00.000Z',
    completedAt: '2026-09-19T12:05:00.000Z',
    durationMs: duration,
    exitCode: 0,
    metrics: { ...emptyMetrics(), ...metrics },
    artifacts: { changedFiles: [] },
    error: null,
    eventCount: 0,
    invocation: null,
  });

  return {
    id: opts.id ?? makeId('battle'),
    protocolVersion: 1,
    arenaVersion: ARENA_VERSION,
    status: opts.status ?? 'completed',
    spec,
    task: { title: 'Test battle', prompt: 'Fix the bug.', source: { kind: 'prompt' } },
    repository: { source: 'empty', kind: 'empty', commit: null, ref: null, dirty: null },
    environment: {
      os: { platform: 'linux', release: '6.0', arch: 'x64' },
      node: 'v24.0.0',
      git: '2.45.0',
      arenaVersion: ARENA_VERSION,
      ci: false,
      cpuCount: 8,
      memoryGb: 16,
      agents: {},
      sharedFlags: {},
      recordedAt: '2026-09-19T12:00:00.000Z',
    },
    runs: {
      a: run('a', opts.statusA ?? 'completed', opts.metricsA ?? {}, opts.durationA ?? 60_000),
      b: run('b', opts.statusB ?? 'completed', opts.metricsB ?? {}, opts.durationB ?? 60_000),
    },
    evaluation: null,
    verdict:
      opts.winner === null
        ? null
        : {
            winner: opts.winner ?? 'a',
            confidence: 0.8,
            method: 'deterministic',
            reasons: ['tests'],
            decisiveFactors: ['tests_passed'],
            caveats: [],
            breakdown: [],
            efficiency: null,
            judge: null,
          },
    insights: [],
    verification: { kind: 'local', eligible: false, sandbox: null },
    demo: false,
    integrity: null,
    createdAt: '2026-09-19T12:00:00.000Z',
    startedAt: '2026-09-19T12:00:00.000Z',
    completedAt: '2026-09-19T12:05:00.000Z',
    error: opts.status === 'failed' ? 'both runs failed' : null,
  };
}

export interface TestHarness {
  deps: CliDeps;
  out: () => string;
  err: () => string;
  json: <T = unknown>() => T;
  /** every spec handed to runBattle, in order */
  specs: BattleSpecInput[];
  options: RunBattleOptions[];
  opened: string[];
  fetches: Array<{ url: string; method: string; body: unknown }>;
}

export interface TestHarnessOptions {
  home: string;
  record?: BattleRecord;
  adapters?: AgentAdapter[];
  prompter?: Partial<Prompter>;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
  cwd?: string;
  fetchImpl?: typeof globalThis.fetch;
  platform?: string;
}

/** A CliDeps wired to fakes, plus the buffers a test asserts on. */
export function testHarness(opts: TestHarnessOptions): TestHarness {
  let stdout = '';
  let stderr = '';
  const specs: BattleSpecInput[] = [];
  const options: RunBattleOptions[] = [];
  const opened: string[] = [];
  const fetches: Array<{ url: string; method: string; body: unknown }> = [];

  const prompter: Prompter = {
    intro: () => {},
    outro: () => {},
    note: () => {},
    cancel: () => {},
    text: async () => null,
    select: async () => null,
    confirm: async () => null,
    ...opts.prompter,
  } as Prompter;

  const deps: CliDeps = {
    runBattle: async (spec, runOptions = {}) => {
      specs.push(spec);
      options.push(runOptions);
      const record = opts.record ?? fakeRecord();
      // The engine always saves a record; the CLI reads report paths and events from the store.
      const store = deps.createStateStore(runOptions.home ?? opts.home);
      await store.saveRecord({ ...record, spec: battleSpecSchema.parse(spec) });
      return { ...record, spec: battleSpecSchema.parse(spec) };
    },
    runDemoBattle: async (runOptions = {}) => {
      options.push(runOptions);
      const record = opts.record ?? fakeRecord();
      const store = deps.createStateStore(runOptions.home ?? opts.home);
      await store.saveRecord(record);
      return record;
    },
    createUploader: (() => {
      throw new Error('createUploader was called without a stub');
    }) as unknown as CliDeps['createUploader'],
    createStateStore: (home?: string) => createStateStore(home ?? opts.home),
    createRegistry: () => stubRegistry(opts.adapters ?? [stubAdapter({ id: 'fake', displayName: 'Fake' })]),
    detectAgents: async (registry) =>
      Promise.all(registry.list().map((adapter) => adapter.detect(opts.env ?? {}))),
    fetchImpl:
      opts.fetchImpl ??
      (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        fetches.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    openUrl: async (target) => {
      opened.push(target);
    },
    prompter,
    env: opts.env ?? {},
    cwd: () => opts.cwd ?? opts.home,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    isTTY: opts.isTTY === true,
    platform: opts.platform ?? 'linux',
    writeOut: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    },
    arenaVersion: ARENA_VERSION,
  };

  return {
    deps,
    out: () => stdout,
    err: () => stderr,
    json: <T>() => JSON.parse(stdout) as T,
    specs,
    options,
    opened,
    fetches,
  };
}
