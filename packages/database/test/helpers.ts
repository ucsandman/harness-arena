import type { ArenaEvent, BattleRecord, BattleStatus, Visibility } from '@harness-arena/protocol';
import { arenaEventSchema, battleRecordSchema, emptyMetrics } from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import { createDb } from '../src/client.js';

/** An in-memory PGlite database with the migrations applied. Costs nothing and touches no disk. */
export async function freshDb(): Promise<ArenaDb> {
  const handle = await createDb({ url: 'pglite://memory' });
  await handle.migrate();
  return handle;
}

let counter = 0;

export function nextBattleId(): string {
  counter += 1;
  return `btl_${counter.toString(36).padStart(16, '0')}`;
}

export interface HarnessFixture {
  name: string;
  source: string;
  kind: 'vanilla' | 'github' | 'git' | 'local';
  commit?: string | null;
}

export interface ChangedFileFixture {
  path: string;
  kind: 'create' | 'modify' | 'delete' | 'rename';
  linesAdded?: number;
  linesRemoved?: number;
}

export interface RecordFixtureOptions {
  id?: string;
  status?: BattleStatus;
  winner?: 'a' | 'b' | 'tie' | 'inconclusive' | null;
  confidence?: number;
  category?: string;
  demo?: boolean;
  eligible?: boolean;
  verificationKind?: 'local' | 'cloud';
  visibility?: Visibility;
  agentA?: string;
  agentB?: string;
  harnessA?: HarnessFixture;
  harnessB?: HarnessFixture;
  diffA?: string;
  finalResponseA?: string;
  repositorySource?: string;
  repositoryKind?: 'github' | 'git' | 'local' | 'empty';
  /** null drops the resolved repository commit, which blocks rating eligibility */
  repositoryCommit?: string | null;
  repositoryDirty?: boolean;
  /** both sides run concurrently */
  parallel?: boolean;
  modelA?: string | null;
  modelB?: string | null;
  changedFilesA?: ChangedFileFixture[];
  changedFilesB?: ChangedFileFixture[];
  tokensA?: number;
  tokensB?: number;
  costA?: number;
  costB?: number;
  /** verdict hierarchy rows; the integrity checks and the profile's correctness rate read them */
  breakdown?: { factor: string; result: 'a' | 'b' | 'tie' | 'n/a'; detail?: string }[];
  privacyUpload?: 'none' | 'metrics' | 'events' | 'full';
  /** non-default efficiency weights raise the custom_efficiency_config warning */
  efficiencyMinAdvantage?: number;
  benchmark?: { slug: string; versionId: string; version: string; taskId: string; trial?: number };
  createdAt?: string;
}

const vanilla: HarnessFixture = { name: 'vanilla', source: 'vanilla', kind: 'vanilla', commit: null };

function runInput(
  battleId: string,
  side: 'a' | 'b',
  agentId: string,
  harness: HarnessFixture,
  extras: {
    diff?: string;
    finalResponse?: string;
    model?: string | null;
    changedFiles?: ChangedFileFixture[];
    tokens?: number;
    cost?: number;
  } = {},
) {
  const changedFiles = (
    extras.changedFiles ?? [{ path: 'src/index.ts', kind: 'modify' as const, linesAdded: 4, linesRemoved: 1 }]
  ).map((file) => ({
    path: file.path,
    kind: file.kind,
    linesAdded: file.linesAdded ?? 1,
    linesRemoved: file.linesRemoved ?? 0,
  }));
  return {
    // Run ids are unique per battle, exactly as the engine generates them.
    id: `run_${battleId.slice(4)}${side}`,
    side,
    label: side === 'a' ? 'Harness A' : 'Harness B',
    status: 'completed',
    agent: {
      id: agentId,
      version: '1.0.0',
      model: extras.model === undefined ? 'test-model' : extras.model,
      capabilities: { tokens: 'observed', cost: 'observed', model: 'observed' },
    },
    harness: {
      name: harness.name,
      source: harness.source,
      kind: harness.kind,
      commit: harness.commit ?? null,
      manifest: null,
      appliedFiles: harness.kind === 'vanilla' ? [] : ['CLAUDE.md'],
      executedCommands: [],
    },
    startedAt: '2026-09-19T10:00:00.000Z',
    completedAt: '2026-09-19T10:05:00.000Z',
    durationMs: side === 'a' ? 300_000 : 240_000,
    exitCode: 0,
    // The protocol requires every metric key to be present; unknown ones are explicitly unavailable.
    metrics: {
      ...emptyMetrics(),
      duration_ms: { value: side === 'a' ? 300_000 : 240_000, status: 'calculated', source: 'core:timer' },
      tests_passed: { value: side === 'a' ? 12 : 11, status: 'observed', source: 'evaluator:tests' },
      ...(extras.tokens === undefined
        ? {}
        : { tokens_total: { value: extras.tokens, status: 'observed', source: 'adapter:usage' } }),
      cost_usd:
        extras.cost === undefined
          ? { value: null, status: 'unavailable' }
          : { value: extras.cost, status: 'observed', source: 'adapter:usage' },
    },
    artifacts: {
      diff: extras.diff ?? null,
      finalResponse: extras.finalResponse ?? null,
      changedFiles,
    },
    error: null,
    eventCount: 3,
    invocation: { command: 'claude', args: ['--output-format', 'stream-json'], envKeys: ['PATH'] },
  };
}

/** A minimal but genuinely valid BattleRecord: built as input, then parsed by the protocol schema. */
export function buildRecord(opts: RecordFixtureOptions = {}): BattleRecord {
  const winner = opts.winner === undefined ? 'a' : opts.winner;
  const id = opts.id ?? nextBattleId();
  const input = {
    id,
    protocolVersion: 1,
    arenaVersion: '0.1.0',
    status: opts.status ?? 'completed',
    spec: {
      version: 1,
      title: 'Fix the failing parser test',
      task: { kind: 'prompt', prompt: 'Fix the failing parser test.' },
      repository: { source: opts.repositorySource ?? 'https://github.com/acme/widget' },
      competitors: {
        a: {
          agent: { id: opts.agentA ?? 'claude-code' },
          harness: { source: (opts.harnessA ?? vanilla).source },
        },
        b: {
          agent: { id: opts.agentB ?? 'claude-code' },
          harness: { source: (opts.harnessB ?? vanilla).source },
        },
      },
      visibility: opts.visibility ?? 'private',
      parallel: opts.parallel ?? false,
      privacy: { upload: opts.privacyUpload ?? 'none' },
      ...(opts.efficiencyMinAdvantage === undefined
        ? {}
        : { evaluation: { efficiency: { minAdvantage: opts.efficiencyMinAdvantage } } }),
      ...(opts.benchmark ? { benchmark: { trial: 1, ...opts.benchmark } } : {}),
      ...(opts.category ? { category: opts.category } : {}),
    },
    task: {
      title: 'Fix the failing parser test',
      prompt: 'Fix the failing parser test.',
      source: { kind: 'prompt' },
    },
    repository: {
      source: opts.repositorySource ?? 'https://github.com/acme/widget',
      kind: opts.repositoryKind ?? 'github',
      commit:
        opts.repositoryCommit === undefined
          ? 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
          : opts.repositoryCommit,
      ref: 'main',
      dirty: opts.repositoryDirty ?? false,
    },
    environment: {
      os: { platform: 'linux', release: '6.1.0', arch: 'x64' },
      node: '24.0.0',
      git: '2.45.0',
      arenaVersion: '0.1.0',
      ci: false,
      cpuCount: 8,
      memoryGb: 32,
      agents: { 'claude-code': { version: '2.1.278', userConfigIsolated: true } },
      recordedAt: '2026-09-19T09:59:00.000Z',
    },
    runs: {
      a: runInput(id, 'a', opts.agentA ?? 'claude-code', opts.harnessA ?? vanilla, {
        diff: opts.diffA,
        finalResponse: opts.finalResponseA,
        model: opts.modelA,
        changedFiles: opts.changedFilesA,
        tokens: opts.tokensA,
        cost: opts.costA,
      }),
      b: runInput(id, 'b', opts.agentB ?? 'claude-code', opts.harnessB ?? vanilla, {
        model: opts.modelB,
        changedFiles: opts.changedFilesB,
        tokens: opts.tokensB,
        cost: opts.costB,
      }),
    },
    evaluation: null,
    verdict: winner
      ? {
          winner,
          confidence: opts.confidence ?? 0.8,
          method: 'deterministic',
          reasons: ['Side A passed one more test.'],
          decisiveFactors: ['tests_passed'],
          caveats: [],
          ...(opts.breakdown
            ? { breakdown: opts.breakdown.map((row) => ({ detail: 'fixture', ...row })) }
            : {}),
          judge: null,
        }
      : null,
    verification: {
      kind: opts.verificationKind ?? 'local',
      eligible: opts.eligible ?? false,
      sandbox: null,
    },
    demo: opts.demo ?? false,
    createdAt: opts.createdAt ?? '2026-09-19T09:59:00.000Z',
    startedAt: '2026-09-19T10:00:00.000Z',
    completedAt: '2026-09-19T10:05:00.000Z',
    error: null,
  };
  return battleRecordSchema.parse(input);
}

export function buildEvent(
  battleId: string,
  seq: number,
  type: 'warning' | 'agent.thinking' = 'warning',
): ArenaEvent {
  const payload = type === 'warning' ? { message: `note ${seq}` } : { chars: seq };
  return arenaEventSchema.parse({
    v: 1,
    id: `evt_${seq.toString(36).padStart(8, '0')}`,
    battleId,
    runId: null,
    side: null,
    seq,
    ts: new Date(Date.UTC(2026, 8, 19, 10, 0, seq % 60)).toISOString(),
    tOffsetMs: seq * 10,
    source: { adapter: 'fake', native: 'test' },
    confidence: 'observed',
    type,
    payload,
  });
}
