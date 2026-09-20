import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { battleSpecSchema } from '@harness-arena/protocol';
import type { BattleSpec, BattleSpecInput } from '@harness-arena/protocol';
import { createProgram } from '../src/program.js';
import { removeDir, stubAdapter, tempDir, testHarness } from './helpers.js';

/**
 * `arena benchmark` against injected dependencies: the pack on disk is the committed one, runBattle is
 * a fake, and what is asserted is the specs the engine received and the JSON the command printed.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SMOKE_PACK = path.join(REPO_ROOT, 'examples', 'benchmarks', 'arena-smoke', 'pack.yaml');

const ADAPTERS = [stubAdapter({ id: 'fake', displayName: 'Fake agent' })];

let home: string;

beforeEach(() => {
  home = tempDir('benchmark');
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

describe('arena benchmark validate', () => {
  it('prints the content version id and the battle count', async () => {
    const t = harness();
    await run(t, ['benchmark', 'validate', SMOKE_PACK, '--json', '--home', home]);
    const json = t.json<{
      valid: boolean;
      slug: string;
      versionId: string;
      tasks: number;
      battles: number;
      categories: string[];
    }>();
    expect(json.valid).toBe(true);
    expect(json.slug).toBe('arena-smoke');
    expect(json.versionId).toMatch(/^bmv_[0-9a-f]{24}$/);
    expect(json.tasks).toBe(3);
    expect(json.battles).toBe(3);
    expect(json.categories).toEqual(['debugging', 'refactoring', 'testing']);
  });

  it('reports the offending field of an invalid pack', async () => {
    const t = harness();
    const file = path.join(home, 'broken.yaml');
    fs.writeFileSync(file, 'benchmark: 1\nname: No slug\nversion: "1"\ntasks: []\n');
    await expect(run(t, ['benchmark', 'validate', file, '--home', home])).rejects.toThrow(/slug/);
  });
});

describe('arena benchmark list', () => {
  it('finds packs in the repository examples directory', async () => {
    const t = harness();
    await run(t, ['benchmark', 'list', '--json', '--home', home]);
    const json = t.json<{ local: Array<{ slug: string; versionId: string; tasks: number }> }>();
    const smoke = json.local.find((entry) => entry.slug === 'arena-smoke');
    expect(smoke).toBeDefined();
    expect(smoke?.tasks).toBe(3);
    expect(smoke?.versionId).toMatch(/^bmv_/);
  });

  it('asks the server when --server is given and a device token exists', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const t = harness({
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
        return new Response(
          JSON.stringify({
            benchmarks: [
              {
                versionId: 'bmv_' + 'a'.repeat(24),
                slug: 'server-pack',
                name: 'Server pack',
                version: '2.0.0',
                description: null,
                author: null,
                categories: ['debugging'],
                taskCount: 4,
                battlesPerRun: 8,
                visibility: 'public',
                createdAt: '2026-09-19T10:00:00.000Z',
              },
            ],
            count: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await t.deps
      .createStateStore(home)
      .setConfig({ token: 'tok_secret', serverUrl: 'https://arena.example' });

    await run(t, ['benchmark', 'list', '--server', '--json', '--home', home]);
    expect(calls[0]?.url).toContain('https://arena.example/api/v1/benchmarks');
    expect(calls[0]?.auth).toBe('Bearer tok_secret');
    const json = t.json<{ server: Array<{ slug: string }> }>();
    expect(json.server.map((entry) => entry.slug)).toEqual(['server-pack']);
    expect(t.out()).not.toContain('tok_secret');
  });
});

describe('arena benchmark publish', () => {
  it('posts the pack and prints the version id the server assigned', async () => {
    const bodies: unknown[] = [];
    const t = harness({
      fetchImpl: async (input, init) => {
        bodies.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({
            versionId: 'bmv_' + 'b'.repeat(24),
            slug: 'arena-smoke',
            version: '1.0.0',
            created: true,
            url: 'https://arena.example/benchmarks/arena-smoke',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await t.deps
      .createStateStore(home)
      .setConfig({ token: 'tok_secret', serverUrl: 'https://arena.example' });

    await run(t, ['benchmark', 'publish', SMOKE_PACK, '--json', '--home', home]);
    const call = bodies[0] as { url: string; method: string; body: { pack: { slug: string } } };
    expect(call.url).toBe('https://arena.example/api/v1/benchmarks');
    expect(call.method).toBe('POST');
    expect(call.body.pack.slug).toBe('arena-smoke');
    expect(t.json<{ created: boolean; url: string }>().url).toBe(
      'https://arena.example/benchmarks/arena-smoke',
    );
  });

  it('refuses to publish without a login', async () => {
    const t = harness();
    await expect(run(t, ['benchmark', 'publish', SMOKE_PACK, '--home', home])).rejects.toThrow(/arena login/);
  });
});

describe('arena benchmark run', () => {
  it('runs one battle per task with the pack provenance on every spec', async () => {
    const t = harness();
    await run(t, [
      'benchmark',
      'run',
      SMOKE_PACK,
      '--a',
      'vanilla',
      '--b',
      'https://github.com/owner/harness',
      '--agent',
      'fake',
      '--json',
      '--home',
      home,
    ]);
    const parsed = specs(t);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((spec) => spec.benchmark?.taskId)).toEqual([
      'debugging-notes',
      'refactoring-notes',
      'testing-notes',
    ]);
    for (const spec of parsed) {
      expect(spec.benchmark?.slug).toBe('arena-smoke');
      expect(spec.benchmark?.versionId).toMatch(/^bmv_[0-9a-f]{24}$/);
      expect(spec.benchmark?.trial).toBe(1);
      expect(spec.competitors.a.harness.source).toBe('vanilla');
      expect(spec.competitors.b.harness.source).toBe('https://github.com/owner/harness');
      expect(spec.competitors.a.agent.id).toBe('fake');
      expect(spec.privacy.upload).toBe('none');
      expect(spec.title).toContain('Arena smoke pack');
    }
    expect(parsed.map((spec) => spec.category)).toEqual(['debugging', 'refactoring', 'testing']);

    const json = t.json<{
      pack: { slug: string; versionId: string };
      rows: Array<{ taskId: string; trial: number; battleId: string }>;
      summary: { battles: number; completed: number; wins: { a: number } };
    }>();
    expect(json.pack.slug).toBe('arena-smoke');
    expect(json.rows).toHaveLength(3);
    expect(json.summary.battles).toBe(3);
    expect(json.summary.completed).toBe(3);
  });

  it('--trials replaces the pack trial count and --task runs one task', async () => {
    const t = harness();
    await run(t, [
      'benchmark',
      'run',
      'arena-smoke',
      '--a',
      'vanilla',
      '--b',
      'vanilla',
      '--agent',
      'fake',
      '--trials',
      '3',
      '--task',
      'testing-notes',
      '--json',
      '--home',
      home,
    ]);
    const parsed = specs(t);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((spec) => spec.benchmark?.trial)).toEqual([1, 2, 3]);
    expect(new Set(parsed.map((spec) => spec.benchmark?.taskId))).toEqual(new Set(['testing-notes']));
  });

  it('writes a markdown report when asked', async () => {
    const t = harness();
    const file = path.join(home, 'report.md');
    await run(t, [
      'benchmark',
      'run',
      SMOKE_PACK,
      '--a',
      'vanilla',
      '--b',
      'vanilla',
      '--agent',
      'fake',
      '--task',
      'debugging-notes',
      '--markdown',
      file,
      '--json',
      '--home',
      home,
    ]);
    const markdown = fs.readFileSync(file, 'utf8');
    expect(markdown).toContain('## Benchmark: Arena smoke pack');
    expect(markdown).toContain('debugging-notes');
    expect(markdown).toContain('Wins:');
  });

  it('requires both sides and reports an unknown pack', async () => {
    const t = harness();
    await expect(run(t, ['benchmark', 'run', SMOKE_PACK, '--a', 'vanilla', '--home', home])).rejects.toThrow(
      /required/,
    );
    await expect(
      run(t, ['benchmark', 'run', 'no-such-pack', '--a', 'vanilla', '--b', 'vanilla', '--home', home]),
    ).rejects.toThrow(/no benchmark pack/);
  });
});
