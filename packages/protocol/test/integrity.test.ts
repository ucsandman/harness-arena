import { describe, expect, it } from 'vitest';
import type { BattleRecord } from '../src/index.js';
import {
  battleRecordSchema,
  buildIntegrityReport,
  canonicalJson,
  computeIntegrityFlags,
  emptyMetrics,
  fingerprintInput,
  INTEGRITY_CODES,
  INTEGRITY_LABELS,
  isIntegrityTestPath,
} from '../src/index.js';

interface SideOptions {
  agent?: string;
  model?: string | null;
  harness?: { kind: 'vanilla' | 'github' | 'git' | 'local'; source: string; commit?: string | null };
  changedFiles?: { path: string; kind: 'create' | 'modify' | 'delete' | 'rename' }[];
}

interface RecordOptions {
  demo?: boolean;
  winner?: 'a' | 'b' | 'tie' | 'inconclusive' | null;
  repositoryCommit?: string | null;
  repositoryKind?: 'github' | 'git' | 'local' | 'empty';
  dirty?: boolean | null;
  parallel?: boolean;
  upload?: 'none' | 'metrics' | 'events' | 'full';
  minAdvantage?: number;
  a?: SideOptions;
  b?: SideOptions;
}

const GITHUB_A = {
  kind: 'github' as const,
  source: 'https://github.com/acme/superclaude',
  commit: 'abc1234',
};
const VANILLA = { kind: 'vanilla' as const, source: 'vanilla', commit: null };

function side(id: 'a' | 'b', opts: SideOptions = {}) {
  const harness = opts.harness ?? (id === 'a' ? GITHUB_A : VANILLA);
  return {
    id: `run_0000000000000${id === 'a' ? 1 : 2}`,
    side: id,
    label: id.toUpperCase(),
    status: 'completed',
    agent: {
      id: opts.agent ?? 'claude-code',
      version: '1.0.0',
      model: opts.model === undefined ? 'sonnet' : opts.model,
      capabilities: { tokens: 'observed' },
    },
    harness: {
      name: harness.source,
      source: harness.source,
      kind: harness.kind,
      commit: harness.commit ?? null,
      manifest: null,
      appliedFiles: [],
      executedCommands: [],
    },
    startedAt: '2026-09-19T10:00:00.000Z',
    completedAt: '2026-09-19T10:05:00.000Z',
    durationMs: 300_000,
    exitCode: 0,
    metrics: emptyMetrics(),
    artifacts: {
      diff: null,
      finalResponse: null,
      changedFiles: (opts.changedFiles ?? [{ path: 'src/index.ts', kind: 'modify' as const }]).map(
        (file) => ({
          ...file,
          linesAdded: 1,
          linesRemoved: 0,
        }),
      ),
    },
    error: null,
    eventCount: 0,
    invocation: null,
  };
}

/** A battle that passes every check: two different harnesses, pinned commits, a decided winner. */
function makeRecord(opts: RecordOptions = {}): BattleRecord {
  const winner = opts.winner === undefined ? 'a' : opts.winner;
  return battleRecordSchema.parse({
    id: 'btl_0000000000000001',
    protocolVersion: 1,
    arenaVersion: '0.1.0',
    status: 'completed',
    spec: {
      version: 1,
      task: { kind: 'prompt', prompt: 'Fix the failing test.' },
      repository: { source: 'https://github.com/acme/widget' },
      competitors: {
        a: { agent: { id: 'claude-code' }, harness: { source: 'https://github.com/acme/superclaude' } },
        b: { agent: { id: 'claude-code' }, harness: { source: 'vanilla' } },
      },
      parallel: opts.parallel ?? false,
      privacy: { upload: opts.upload ?? 'full' },
      ...(opts.minAdvantage === undefined
        ? {}
        : { evaluation: { efficiency: { minAdvantage: opts.minAdvantage } } }),
    },
    task: { title: 'Fix it', prompt: 'Fix the failing test.', source: { kind: 'prompt' } },
    repository: {
      source: 'https://github.com/acme/widget',
      kind: opts.repositoryKind ?? 'github',
      commit: opts.repositoryCommit === undefined ? 'a1b2c3d4e5f6' : opts.repositoryCommit,
      ref: 'main',
      dirty: opts.dirty === undefined ? false : opts.dirty,
    },
    environment: {
      os: { platform: 'linux', release: '6.1.0', arch: 'x64' },
      node: '24.0.0',
      git: '2.45.0',
      arenaVersion: '0.1.0',
      ci: false,
      cpuCount: 8,
      memoryGb: 32,
      agents: {},
      recordedAt: '2026-09-19T09:59:00.000Z',
    },
    runs: { a: side('a', opts.a), b: side('b', opts.b) },
    evaluation: null,
    verdict: winner
      ? {
          winner,
          confidence: 0.8,
          method: 'deterministic',
          reasons: [],
          decisiveFactors: [],
          caveats: [],
          judge: null,
        }
      : null,
    verification: { kind: 'local', eligible: false, sandbox: null },
    demo: opts.demo ?? false,
    createdAt: '2026-09-19T09:59:00.000Z',
    startedAt: '2026-09-19T10:00:00.000Z',
    completedAt: '2026-09-19T10:05:00.000Z',
    error: null,
  });
}

function codes(record: BattleRecord, opts?: { duplicateOf?: string | null }): string[] {
  return computeIntegrityFlags(record, opts).map((flag) => flag.code);
}

function eligible(record: BattleRecord, opts?: { duplicateOf?: string | null }): boolean {
  return buildIntegrityReport(computeIntegrityFlags(record, opts), null, 'test').eligible;
}

describe('test path detection', () => {
  it('matches the directories and suffixes a test suite actually uses', () => {
    for (const p of [
      'test/session.test.js',
      'tests/unit/session.js',
      'src/__tests__/session.ts',
      'packages/app/src/session.spec.ts',
      'spec/models/user_spec.rb',
      'src\\auth\\session.test.ts',
    ]) {
      expect(isIntegrityTestPath(p)).toBe(true);
    }
    for (const p of ['src/index.ts', 'README.md', 'src/protest/manifest.json', 'lib/latest/build.js']) {
      expect(isIntegrityTestPath(p)).toBe(false);
    }
  });
});

describe('computeIntegrityFlags', () => {
  it('passes a clean battle with no flags at all', () => {
    const record = makeRecord();
    expect(codes(record)).toEqual([]);
    expect(eligible(record)).toBe(true);
  });

  it('blocks demo data, undecided verdicts and the same competitor on both sides', () => {
    expect(codes(makeRecord({ demo: true }))).toContain('demo');
    expect(codes(makeRecord({ winner: null }))).toContain('no_decision');
    expect(codes(makeRecord({ winner: 'inconclusive' }))).toContain('no_decision');

    const mirror = makeRecord({ a: { harness: VANILLA }, b: { harness: VANILLA } });
    expect(codes(mirror)).toContain('same_competitor');
    expect(eligible(mirror)).toBe(false);

    // the same source on a different commit is a real matchup: version A vs version B
    const versions = makeRecord({
      a: { harness: { ...GITHUB_A, commit: 'aaaaaaa' } },
      b: { harness: { ...GITHUB_A, commit: 'bbbbbbb' } },
    });
    expect(codes(versions)).not.toContain('same_competitor');
  });

  it('blocks an unpinned github harness, warns for an unpinned local one, exempts vanilla', () => {
    const unpinned = makeRecord({ a: { harness: { ...GITHUB_A, commit: null } } });
    const flag = computeIntegrityFlags(unpinned).find((f) => f.code === 'harness_commit_missing');
    expect(flag).toMatchObject({ severity: 'block', side: 'a' });
    expect(eligible(unpinned)).toBe(false);

    const local = makeRecord({
      a: { harness: { kind: 'local', source: '/home/wes/harness', commit: null } },
    });
    const localFlag = computeIntegrityFlags(local).find((f) => f.code === 'harness_commit_missing');
    expect(localFlag).toMatchObject({ severity: 'warn', side: 'a' });
    expect(eligible(local)).toBe(true);

    // side B is vanilla with commit null in every other case here and never produced a flag
    expect(codes(makeRecord())).not.toContain('harness_commit_missing');
  });

  it('blocks a missing repository commit, including an empty repository, and warns on a dirty one', () => {
    expect(eligible(makeRecord({ repositoryCommit: null }))).toBe(false);
    expect(codes(makeRecord({ repositoryCommit: null }))).toContain('repository_commit_missing');
    expect(codes(makeRecord({ repositoryCommit: null, repositoryKind: 'empty' }))).toContain(
      'repository_commit_missing',
    );

    const dirty = makeRecord({ dirty: true });
    expect(codes(dirty)).toEqual(['repository_dirty']);
    expect(eligible(dirty)).toBe(true);
  });

  it('warns on modified tests, blocks deleted tests, and ignores a newly written test', () => {
    const modified = makeRecord({
      b: { changedFiles: [{ path: 'test/session.test.js', kind: 'modify' }] },
    });
    const modifiedFlag = computeIntegrityFlags(modified).find((f) => f.code === 'tests_modified');
    expect(modifiedFlag).toMatchObject({ severity: 'warn', side: 'b' });
    expect(modifiedFlag?.detail).toContain('test/session.test.js');
    expect(eligible(modified)).toBe(true);

    const deleted = makeRecord({
      a: { changedFiles: [{ path: 'test/session.test.js', kind: 'delete' }] },
    });
    expect(computeIntegrityFlags(deleted).find((f) => f.code === 'tests_deleted')).toMatchObject({
      severity: 'block',
      side: 'a',
    });
    expect(eligible(deleted)).toBe(false);

    const written = makeRecord({
      a: { changedFiles: [{ path: 'test/session.regression.test.js', kind: 'create' }] },
    });
    expect(codes(written)).toEqual([]);
  });

  it('blocks a duplicate only when the caller found one', () => {
    expect(codes(makeRecord(), { duplicateOf: null })).toEqual([]);
    const flags = computeIntegrityFlags(makeRecord(), { duplicateOf: 'btl_0000000000000009' });
    expect(flags.find((f) => f.code === 'duplicate_battle')).toMatchObject({ severity: 'block' });
    expect(flags[0]?.detail).toContain('btl_0000000000000009');
  });

  it('warns about everything that makes a comparison less clean without invalidating it', () => {
    expect(codes(makeRecord({ a: { agent: 'codex' } }))).toContain('different_agents');
    expect(codes(makeRecord({ a: { model: 'opus' } }))).toContain('different_models');
    expect(codes(makeRecord({ a: { model: null } }))).not.toContain('different_models');
    expect(codes(makeRecord({ parallel: true }))).toContain('parallel_execution');
    expect(codes(makeRecord({ minAdvantage: 0.2 }))).toContain('custom_efficiency_config');
    expect(codes(makeRecord({ minAdvantage: 0.05 }))).not.toContain('custom_efficiency_config');
    expect(codes(makeRecord({ upload: 'none' }))).toContain('no_uploaded_evidence');
    expect(codes(makeRecord({ upload: 'metrics' }))).not.toContain('no_uploaded_evidence');

    // every one of those is a warning: the battle still counts
    for (const record of [
      makeRecord({ a: { agent: 'codex' } }),
      makeRecord({ a: { model: 'opus' } }),
      makeRecord({ parallel: true }),
      makeRecord({ minAdvantage: 0.2 }),
      makeRecord({ upload: 'none' }),
    ]) {
      expect(eligible(record)).toBe(true);
    }
  });

  it('emits flags in the order INTEGRITY_CODES declares them and labels every code', () => {
    const messy = makeRecord({
      demo: true,
      winner: 'inconclusive',
      repositoryCommit: null,
      dirty: true,
      parallel: true,
      upload: 'none',
      a: { agent: 'codex', model: 'opus', harness: { ...GITHUB_A, commit: null } },
      b: { changedFiles: [{ path: 'test/session.test.js', kind: 'delete' }] },
    });
    const emitted = codes(messy);
    const declared = INTEGRITY_CODES.filter((code) => emitted.includes(code));
    expect(emitted).toEqual(declared);
    for (const code of INTEGRITY_CODES) expect(INTEGRITY_LABELS[code]).toBeTruthy();
  });
});

describe('fingerprintInput', () => {
  it('is null without a repository commit and stable across key order', () => {
    expect(fingerprintInput(makeRecord({ repositoryCommit: null }))).toBeNull();
    const input = fingerprintInput(makeRecord());
    expect(input).toBeTypeOf('string');
    expect(fingerprintInput(makeRecord())).toBe(input);
    // canonicalJson sorts keys, so a re-serialised copy hashes the same
    expect(canonicalJson(JSON.parse(input as string))).toBe(input);
  });

  it('changes when anything that defines the matchup changes', () => {
    const base = fingerprintInput(makeRecord()) as string;
    const variants = [
      makeRecord({ repositoryCommit: 'ffffff1' }),
      makeRecord({ a: { model: 'opus' } }),
      makeRecord({ a: { agent: 'codex' } }),
      makeRecord({ a: { harness: { ...GITHUB_A, commit: 'zzz9999' } } }),
      makeRecord({ minAdvantage: 0.2 }),
    ];
    for (const variant of variants) expect(fingerprintInput(variant)).not.toBe(base);

    // and not when something outside the matchup changes
    expect(fingerprintInput(makeRecord({ parallel: true }))).toBe(base);
  });

  it('keeps the sides in place: swapping A and B is a different battle', () => {
    const swapped = makeRecord({ a: { harness: VANILLA }, b: { harness: GITHUB_A } });
    expect(fingerprintInput(swapped)).not.toBe(fingerprintInput(makeRecord()));
  });
});

describe('buildIntegrityReport', () => {
  it('is eligible exactly when no flag blocks', () => {
    const warn = [{ code: 'repository_dirty' as const, severity: 'warn' as const, detail: '', side: null }];
    const block = [{ code: 'demo' as const, severity: 'block' as const, detail: '', side: null }];
    expect(buildIntegrityReport([], null, 'arena/0.1.0')).toMatchObject({
      eligible: true,
      fingerprint: null,
      checkedWith: 'arena/0.1.0',
    });
    expect(buildIntegrityReport(warn, 'abc', 'x').eligible).toBe(true);
    expect(buildIntegrityReport([...warn, ...block], 'abc', 'x').eligible).toBe(false);
  });
});
