import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { battleSpecSchema } from '@harness-arena/protocol';
import type { BattleSpec, BattleSpecInput } from '@harness-arena/protocol';
import type { Uploader } from '@harness-arena/core';
import { createProgram } from '../src/program.js';
import { fakeRecord, removeDir, stubAdapter, tempDir, testHarness } from './helpers.js';

/**
 * `arena experiment` and `arena compare`. Nothing runs an agent: runBattle is the injected fake, so
 * what is asserted is the specs the engine received, the local experiment record, and the requests
 * that would have reached a server.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SMOKE_PACK = path.join(REPO_ROOT, 'examples', 'benchmarks', 'arena-smoke', 'pack.yaml');

const ADAPTERS = [stubAdapter({ id: 'fake', displayName: 'Fake agent' })];

let home: string;

beforeEach(() => {
  home = tempDir('experiment');
});

afterEach(() => {
  removeDir(home);
});

function harness(overrides: Partial<Parameters<typeof testHarness>[0]> = {}) {
  return testHarness({ home, adapters: ADAPTERS, cwd: REPO_ROOT, ...overrides });
}

async function run(t: ReturnType<typeof testHarness>, argv: string[]): Promise<void> {
  const program = createProgram(t.deps);
  await program.parseAsync(['node', 'arena', ...argv]);
}

function specs(t: ReturnType<typeof testHarness>): BattleSpec[] {
  return t.specs.map((spec) => battleSpecSchema.parse(spec as BattleSpecInput));
}

const noopUploader: Uploader = {
  createBattle: async (record) => ({
    id: record.id,
    url: 'https://arena.example/battles/' + record.id,
    streamUrl: 'https://arena.example/api/v1/battles/' + record.id + '/stream',
  }),
  pushEvents: async () => {},
  patchRecord: async () => {},
  uploadArtifact: async () => {},
  flush: async () => {},
  stats: () => ({ batches: 0, events: 0, artifacts: 0, records: 0, failures: 0, skipped: 0 }),
};

describe('arena experiment run', () => {
  it('runs control as side A and treatment as side B for every task, and writes a local record', async () => {
    const t = harness();
    await run(t, [
      'experiment',
      'run',
      '--kind',
      'comparison',
      '--control',
      'vanilla',
      '--treatment',
      'https://github.com/owner/harness',
      '--benchmark',
      SMOKE_PACK,
      '--agent',
      'fake',
      '--json',
      '--home',
      home,
    ]);

    const parsed = specs(t);
    expect(parsed).toHaveLength(3);
    for (const spec of parsed) {
      expect(spec.competitors.a.label).toBe('control');
      expect(spec.competitors.a.harness.source).toBe('vanilla');
      expect(spec.competitors.b.label).toBe('treatment');
      expect(spec.competitors.b.harness.source).toBe('https://github.com/owner/harness');
      expect(spec.privacy.upload).toBe('none');
      // no server experiment exists, so no arena link is claimed
      expect(spec.arena?.experimentId).toBeUndefined();
    }

    const json = t.json<{
      id: string;
      kind: string;
      battles: Array<{ battleId: string; treatmentSide: string; taskId: string | null }>;
      summary: { battles: number; comparable: number; evidence: { level: string }; conclusions: string[] };
      file: string;
      url: string | null;
    }>();
    expect(json.id).toMatch(/^exp_/);
    expect(json.kind).toBe('comparison');
    expect(json.battles).toHaveLength(3);
    expect(json.battles.every((battle) => battle.treatmentSide === 'b')).toBe(true);
    expect(json.summary.battles).toBe(3);
    expect(json.summary.conclusions.length).toBeGreaterThan(0);
    expect(json.url).toBeNull();

    const saved = JSON.parse(fs.readFileSync(json.file, 'utf8')) as {
      id: string;
      benchmark: { slug: string; versionId: string } | null;
      summary: { battles: number } | null;
    };
    expect(saved.id).toBe(json.id);
    expect(saved.benchmark?.slug).toBe('arena-smoke');
    expect(saved.summary?.battles).toBe(3);
    expect(fs.existsSync(path.join(home, 'experiments', json.id + '.json'))).toBe(true);
  });

  it('pins commits from harness@commit on both sides', async () => {
    const t = harness();
    await run(t, [
      'experiment',
      'run',
      '--kind',
      'regression',
      '--control',
      'https://github.com/owner/h@1234abc',
      '--treatment',
      'https://github.com/owner/h@abcdef1234567',
      '--benchmark',
      SMOKE_PACK,
      '--task',
      'debugging-notes',
      '--agent',
      'fake',
      '--json',
      '--home',
      home,
    ]);
    const spec = specs(t)[0] as BattleSpec;
    expect(spec.competitors.a.harness.source).toBe('https://github.com/owner/h');
    expect(spec.competitors.a.harness.commit).toBe('1234abc');
    expect(spec.competitors.b.harness.commit).toBe('abcdef1234567');
  });

  it('an ablation must name the component that changed', async () => {
    const t = harness();
    await expect(
      run(t, [
        'experiment',
        'run',
        '--kind',
        'ablation',
        '--control',
        'vanilla',
        '--treatment',
        'vanilla',
        '--benchmark',
        SMOKE_PACK,
        '--home',
        home,
      ]),
    ).rejects.toThrow(/--component/);
  });

  it('refuses an unknown kind and refuses having nothing to run', async () => {
    const t = harness();
    await expect(
      run(t, [
        'experiment',
        'run',
        '--kind',
        'sideways',
        '--control',
        'vanilla',
        '--treatment',
        'vanilla',
        '--benchmark',
        SMOKE_PACK,
        '--home',
        home,
      ]),
    ).rejects.toThrow(/regression, ablation or comparison/);
    await expect(
      run(t, [
        'experiment',
        'run',
        '--kind',
        'comparison',
        '--control',
        'vanilla',
        '--treatment',
        'vanilla',
        '--home',
        home,
      ]),
    ).rejects.toThrow(/--benchmark .*or --spec-dir/);
  });

  it('creates, links and finalizes on the server when logged in and uploading', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const t = harness({
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
        });
        if (url.endsWith('/api/v1/experiments')) {
          return new Response(
            JSON.stringify({
              experiment: {
                id: 'exp_abcdefgh12345678',
                title: 'Server experiment',
                kind: 'comparison',
                status: 'running',
                createdBy: { id: 'usr_1', login: 'tester' },
                control: { label: 'control', harness: { source: 'vanilla', trusted: false } },
                treatment: { label: 'treatment', harness: { source: 'vanilla', trusted: false } },
                changedComponent: null,
                agent: { id: 'fake' },
                target: {
                  kind: 'benchmark',
                  slug: 'arena-smoke',
                  versionId: 'bmv_' + 'a'.repeat(24),
                },
                trials: 1,
                visibility: 'private',
                battleIds: [],
                summary: null,
                createdAt: '2026-09-19T10:00:00.000Z',
                completedAt: null,
              },
              url: 'https://arena.example/experiments/exp_abcdefgh12345678',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await t.deps
      .createStateStore(home)
      .setConfig({ token: 'tok_secret', serverUrl: 'https://arena.example' });

    // A battle is only linked once it actually reached the server, so the stub engine uploads the way
    // the real one does: it hands the record to the uploader, which is what produces the battle URL.
    const uploadingRunBattle: typeof t.deps.runBattle = async (spec, options = {}) => {
      const record = { ...fakeRecord(), spec: battleSpecSchema.parse(spec) };
      await t.deps.createStateStore(options.home ?? home).saveRecord(record);
      if (options.uploader) await options.uploader.createBattle(record);
      t.specs.push(spec);
      return record;
    };

    await createProgram({
      ...t.deps,
      runBattle: uploadingRunBattle,
      createUploader: () => noopUploader,
    }).parseAsync([
      'node',
      'arena',
      'experiment',
      'run',
      '--kind',
      'comparison',
      '--control',
      'vanilla',
      '--treatment',
      'vanilla',
      '--benchmark',
      SMOKE_PACK,
      '--task',
      'debugging-notes',
      '--agent',
      'fake',
      '--upload',
      'metrics',
      '--json',
      '--home',
      home,
    ]);

    const posted = calls.filter((call) => call.method === 'POST').map((call) => call.url);
    expect(posted).toContain('https://arena.example/api/v1/experiments');
    expect(posted).toContain('https://arena.example/api/v1/experiments/exp_abcdefgh12345678/battles');
    expect(posted).toContain('https://arena.example/api/v1/experiments/exp_abcdefgh12345678/finalize');

    const link = calls.find((call) => call.url.endsWith('/battles'));
    expect((link?.body as { treatmentSide: string }).treatmentSide).toBe('b');

    // the battle carries the experiment id so the server can verify the link
    const spec = specs(t)[0] as BattleSpec;
    expect(spec.arena?.experimentId).toBe('exp_abcdefgh12345678');
    expect(spec.privacy.upload).toBe('metrics');
    expect(t.out()).not.toContain('tok_secret');
  });

  it('runs a directory of specs and keeps that experiment local', async () => {
    const t = harness();
    const dir = path.join(home, 'specs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'one.json'),
      JSON.stringify({
        version: 1,
        title: 'Spec one',
        task: { kind: 'prompt', prompt: 'do the thing' },
        repository: { source: 'empty' },
        competitors: {
          a: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
          b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
        },
        privacy: { upload: 'none' },
      }),
    );
    await run(t, [
      'experiment',
      'run',
      '--kind',
      'comparison',
      '--control',
      'vanilla',
      '--treatment',
      'https://github.com/owner/harness',
      '--spec-dir',
      dir,
      '--agent',
      'fake',
      '--json',
      '--home',
      home,
    ]);
    const parsed = specs(t);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.competitors.b.harness.source).toBe('https://github.com/owner/harness');
    const json = t.json<{ summary: { battles: number } }>();
    expect(json.summary.battles).toBe(1);
  });
});

describe('arena experiment show / list', () => {
  it('reads back the record this machine wrote', async () => {
    const t = harness();
    await run(t, [
      'experiment',
      'run',
      '--kind',
      'comparison',
      '--control',
      'vanilla',
      '--treatment',
      'vanilla',
      '--benchmark',
      SMOKE_PACK,
      '--task',
      'debugging-notes',
      '--agent',
      'fake',
      '--json',
      '--home',
      home,
    ]);
    const id = t.json<{ id: string }>().id;

    const reader = harness();
    await run(reader, ['experiment', 'show', id, '--json', '--home', home]);
    const shown = reader.json<{ id: string; summary: { battles: number } | null }>();
    expect(shown.id).toBe(id);
    expect(shown.summary?.battles).toBe(1);

    const lister = harness();
    await run(lister, ['experiment', 'list', '--json', '--home', home]);
    expect(lister.json<{ experiments: Array<{ id: string }> }>().experiments[0]?.id).toBe(id);
  });

  it('says so when neither this machine nor a login has the experiment', async () => {
    const t = harness();
    await expect(run(t, ['experiment', 'show', 'exp_missing0000001', '--home', home])).rejects.toThrow(
      /arena login/,
    );
  });
});

describe('arena compare', () => {
  it('is a regression experiment between two commits of one harness', async () => {
    const t = harness();
    await run(t, [
      'compare',
      'https://github.com/owner/harness',
      '--from',
      '1111111',
      '--to',
      '2222222',
      '--benchmark',
      SMOKE_PACK,
      '--task',
      'debugging-notes',
      '--agent',
      'fake',
      '--json',
      '--home',
      home,
    ]);
    const spec = specs(t)[0] as BattleSpec;
    expect(spec.competitors.a.harness.commit).toBe('1111111');
    expect(spec.competitors.b.harness.commit).toBe('2222222');
    expect(t.json<{ kind: string }>().kind).toBe('regression');
  });
});
