import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { battleSpecSchema } from '@harness-arena/protocol';
import type { ArenaEvent, BattleSpec, BattleSpecInput } from '@harness-arena/protocol';
import type { Uploader } from '@harness-arena/core';
import { createProgram } from '../src/program.js';
import { fakeRecord, metric, removeDir, stubAdapter, tempDir, testHarness } from './helpers.js';

/**
 * Every command parsed from an argv, against injected dependencies. What is asserted is what the
 * engine receives and what reaches stdout, never a mock's own behaviour.
 */

let home: string;

beforeEach(() => {
  home = tempDir('program');
});

afterEach(() => {
  removeDir(home);
});

const ADAPTERS = [
  stubAdapter({ id: 'claude-code', displayName: 'Claude Code' }),
  stubAdapter({ id: 'codex', displayName: 'Codex CLI', installed: false, version: null, auth: 'unknown' }),
  stubAdapter({ id: 'fake', displayName: 'Fake agent' }),
];

function harness(overrides: Parameters<typeof testHarness>[0] extends infer T ? Partial<T> : never = {}) {
  return testHarness({ home, adapters: ADAPTERS, ...overrides });
}

async function run(t: ReturnType<typeof testHarness>, argv: string[]): Promise<void> {
  const program = createProgram(t.deps);
  await program.parseAsync(['node', 'arena', ...argv]);
}

function lastSpec(t: ReturnType<typeof testHarness>): BattleSpec {
  const spec = t.specs.at(-1);
  expect(spec, 'runBattle was never called').toBeDefined();
  return battleSpecSchema.parse(spec as BattleSpecInput);
}

describe('arena battle', () => {
  it('maps harness arguments, agents, models, limits and privacy flags into the spec', async () => {
    const t = harness();
    await run(t, [
      'battle',
      'https://github.com/owner/harness',
      'vanilla',
      '--agent',
      'claude-code',
      '--model',
      'sonnet',
      '--repo',
      'empty',
      '--task',
      'Fix the failing test',
      '--tests',
      'npm test',
      '--build',
      'npm run build',
      '--build',
      'npm run lint',
      '--timeout',
      '15m',
      '--max-turns',
      '40',
      '--upload',
      'events',
      '--exclude',
      'diffs,prompts',
      '--visibility',
      'unlisted',
      '--label-a',
      'Mine',
      '--label-b',
      'Vanilla',
      '--category',
      'debugging',
      '--yes',
      '--home',
      home,
    ]);

    const spec = lastSpec(t);
    expect(spec.competitors.a.harness.source).toBe('https://github.com/owner/harness');
    expect(spec.competitors.b.harness.source).toBe('vanilla');
    expect(spec.competitors.a.agent).toMatchObject({ id: 'claude-code', model: 'sonnet' });
    expect(spec.competitors.b.agent).toMatchObject({ id: 'claude-code', model: 'sonnet' });
    expect(spec.competitors.a.label).toBe('Mine');
    expect(spec.competitors.b.label).toBe('Vanilla');
    expect(spec.task).toEqual({ kind: 'prompt', prompt: 'Fix the failing test' });
    expect(spec.limits.timeoutMs).toBe(15 * 60_000);
    expect(spec.limits.maxTurns).toBe(40);
    expect(spec.evaluation.tests?.command).toBe('npm test');
    expect(spec.evaluation.build).toEqual(['npm run build', 'npm run lint']);
    expect(spec.privacy).toMatchObject({ upload: 'events', exclude: ['diffs', 'prompts'] });
    expect(spec.visibility).toBe('unlisted');
    expect(spec.category).toBe('debugging');
    expect(spec.parallel).toBe(false);
  });

  it('--local-only forces upload none and never builds an uploader', async () => {
    const t = harness();
    // createUploader throws in the harness, so reaching it would fail the test.
    await run(t, [
      'battle',
      'vanilla',
      'vanilla',
      '--agent',
      'fake',
      '--repo',
      'empty',
      '--task',
      'x',
      '--upload',
      'full',
      '--local-only',
      '--yes',
      '--home',
      home,
    ]);
    expect(lastSpec(t).privacy.upload).toBe('none');
    expect(t.options.at(-1)?.uploader).toBeUndefined();
  });

  it('--trust marks both harnesses trusted and --parallel reaches the spec', async () => {
    const t = harness();
    await run(t, [
      'battle',
      'vanilla',
      'vanilla',
      '--agent',
      'fake',
      '--repo',
      'empty',
      '--task',
      'x',
      '--trust',
      '--parallel',
      '--yes',
      '--home',
      home,
    ]);
    const spec = lastSpec(t);
    expect(spec.competitors.a.harness.trusted).toBe(true);
    expect(spec.competitors.b.harness.trusted).toBe(true);
    expect(spec.parallel).toBe(true);
  });

  it('refuses an agent that is not installed, before anything runs', async () => {
    const t = harness();
    await expect(
      run(t, [
        'battle',
        'vanilla',
        'vanilla',
        '--agent',
        'codex',
        '--repo',
        'empty',
        '--task',
        'x',
        '--yes',
        '--home',
        home,
      ]),
    ).rejects.toThrow(/Codex CLI was not found on PATH/);
    expect(t.specs).toHaveLength(0);
  });

  it('refuses an unknown agent id with the list of known ids', async () => {
    const t = harness();
    await expect(
      run(t, [
        'battle',
        'vanilla',
        'vanilla',
        '--agent',
        'gpt5',
        '--repo',
        'empty',
        '--task',
        'x',
        '--yes',
        '--home',
        home,
      ]),
    ).rejects.toThrow(/unknown agent "gpt5".*claude-code/s);
  });

  it('needs a task and says so', async () => {
    const t = harness();
    await expect(
      run(t, ['battle', 'vanilla', 'vanilla', '--agent', 'fake', '--repo', 'empty', '--yes', '--home', home]),
    ).rejects.toThrow(/--task/);
  });

  it('reads the task from a file and resolves an issue reference', async () => {
    const t = harness();
    const file = path.join(home, 'task.md');
    fs.writeFileSync(file, 'Fix the session expiry bug.\n');
    await run(t, [
      'battle',
      'vanilla',
      'vanilla',
      '--agent',
      'fake',
      '--repo',
      'empty',
      '--task-file',
      file,
      '--yes',
      '--home',
      home,
    ]);
    expect(lastSpec(t).task).toMatchObject({ kind: 'prompt', prompt: 'Fix the session expiry bug.\n' });

    await run(t, [
      'battle',
      'vanilla',
      'vanilla',
      '--agent',
      'fake',
      '--repo',
      'https://github.com/owner/project',
      '--issue',
      '137',
      '--yes',
      '--home',
      home,
    ]);
    expect(lastSpec(t).task).toEqual({ kind: 'issue', repo: 'owner/project', number: 137 });
  });

  it('--json prints one JSON document on stdout and keeps human lines on stderr', async () => {
    const record = fakeRecord({ winner: 'a', metricsA: { tests_passed: metric(3) } });
    const t = testHarness({ home, adapters: ADAPTERS, record });
    await run(t, [
      'battle',
      'vanilla',
      'vanilla',
      '--agent',
      'fake',
      '--repo',
      'empty',
      '--task',
      'x',
      '--json',
      '--home',
      home,
    ]);
    const parsed = t.json<{ id: string; status: string; runs: { a: { status: string } } }>();
    expect(parsed.status).toBe('completed');
    expect(parsed.runs.a.status).toBe('completed');
    expect(t.out().trimStart().startsWith('{')).toBe(true);
  });

  it('exits with code 2 when the battle did not complete', async () => {
    const record = fakeRecord({ status: 'failed', statusA: 'failed', statusB: 'failed', winner: null });
    const t = testHarness({ home, adapters: ADAPTERS, record });
    await expect(
      run(t, [
        'battle',
        'vanilla',
        'vanilla',
        '--agent',
        'fake',
        '--repo',
        'empty',
        '--task',
        'x',
        '--yes',
        '--home',
        home,
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('exits with code 3 when the engine asks for trust and the run is not interactive', async () => {
    const t = harness({ isTTY: false });
    // The engine asks through the trust callback; a non-interactive run must refuse, not hang.
    t.deps.runBattle = async (spec, options = {}) => {
      t.specs.push(spec);
      t.options.push(options);
      const harnessStub = {
        name: 'needs-install',
        kind: 'local',
        source: { kind: 'local', path: home },
        dir: home,
        commit: null,
        manifest: null,
      } as unknown as Parameters<NonNullable<typeof options.trust>>[0];
      const approved = options.trust
        ? await options.trust(harnessStub, { commands: ['npm install'], files: ['CLAUDE.md'] })
        : false;
      expect(approved).toBe(false);
      const record = fakeRecord({ status: 'failed', statusA: 'failed', statusB: 'failed', winner: null });
      await t.deps.createStateStore(home).saveRecord(record);
      return record;
    };

    await expect(
      run(t, [
        'battle',
        'vanilla',
        'vanilla',
        '--agent',
        'fake',
        '--repo',
        'empty',
        '--task',
        'x',
        '--yes',
        '--home',
        home,
      ]),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  it('the interactive disclosure names every command the harness declares and honours a refusal', async () => {
    const asked: string[] = [];
    const harnessDir = path.join(home, 'declaring-harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'arena.yaml'),
      [
        'arena: 1',
        'name: needs-install',
        'install:',
        "  command: 'pnpm install --frozen-lockfile'",
        'files:',
        '  - CLAUDE.md',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(harnessDir, 'CLAUDE.md'), '# rules\n');

    const t = testHarness({
      home,
      adapters: ADAPTERS,
      isTTY: true,
      prompter: {
        confirm: async ({ message }) => {
          asked.push(message);
          return false;
        },
      },
    });

    await expect(
      run(t, [
        'battle',
        harnessDir,
        'vanilla',
        '--agent',
        'fake',
        '--repo',
        'empty',
        '--task',
        'x',
        '--timeout',
        '10m',
        '--home',
        home,
      ]),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(t.out()).toContain('pnpm install --frozen-lockfile');
    expect(t.out()).toContain('CLAUDE.md');
    expect(asked.join(' ')).toMatch(/Allow these commands/);
    expect(t.specs).toHaveLength(0);
  });
});

describe('arena run', () => {
  function writeSpec(file: string, overrides: Record<string, unknown> = {}): string {
    const spec = {
      version: 1,
      title: 'From a file',
      task: { kind: 'prompt', prompt: 'Do the thing' },
      repository: { source: 'empty' },
      competitors: {
        a: { label: 'A', agent: { id: 'fake' }, harness: { source: 'vanilla' } },
        b: { label: 'B', agent: { id: 'fake' }, harness: { source: 'vanilla' } },
      },
      privacy: { upload: 'none' },
      ...overrides,
    };
    const target = path.join(home, file);
    fs.writeFileSync(target, JSON.stringify(spec, null, 2));
    return target;
  }

  it('validates the file and hands the parsed spec to the engine', async () => {
    const t = harness();
    await run(t, ['run', writeSpec('battle.json'), '--local-only', '--home', home]);
    expect(lastSpec(t).title).toBe('From a file');
  });

  it('rejects an invalid spec with the failing field', async () => {
    const t = harness();
    const file = path.join(home, 'broken.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, task: { kind: 'prompt' } }));
    await expect(run(t, ['run', file, '--home', home])).rejects.toThrow(/is not a valid battle spec.*task/s);
  });

  it('fetches a pending battle from the server with the device token', async () => {
    const spec = {
      version: 1,
      title: 'Server battle',
      task: { kind: 'prompt', prompt: 'server task' },
      repository: { source: 'empty' },
      competitors: {
        a: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
        b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
      },
      privacy: { upload: 'none' },
    };
    const calls: Array<{ url: string; auth: string | null }> = [];
    const t = testHarness({
      home,
      adapters: ADAPTERS,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify({ spec }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await t.deps
      .createStateStore(home)
      .setConfig({ token: 'tok_secret', serverUrl: 'https://arena.example' });

    await run(t, ['run', '--battle', 'btl_abcdefgh', '--local-only', '--home', home]);
    expect(calls[0]?.url).toBe('https://arena.example/api/v1/battles/btl_abcdefgh');
    expect(calls[0]?.auth).toBe('Bearer tok_secret');
    expect(lastSpec(t).title).toBe('Server battle');
    expect(t.out()).not.toContain('tok_secret');
  });

  it('refuses --battle without a login', async () => {
    const t = harness();
    await expect(run(t, ['run', '--battle', 'btl_abcdefgh', '--home', home])).rejects.toThrow(/arena login/);
  });

  it('runs a pending battle under the id the server issued and never creates a second one', async () => {
    const spec = {
      version: 1,
      title: 'Pending battle',
      task: { kind: 'prompt', prompt: 'server task' },
      repository: { source: 'empty' },
      competitors: {
        a: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
        b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
      },
      privacy: { upload: 'metrics' },
    };
    const uploaderCalls: string[] = [];
    const uploader: Uploader = {
      createBattle: async () => {
        uploaderCalls.push('create');
        return {
          id: 'btl_second00000001',
          url: 'https://arena.example/battles/btl_second00000001',
          streamUrl: 's',
        };
      },
      pushEvents: async () => {},
      patchRecord: async () => {},
      uploadArtifact: async () => {},
      flush: async () => {},
      stats: () => ({ batches: 0, events: 0, artifacts: 0, records: 0, failures: 0, skipped: 0 }),
    };
    const t = testHarness({
      home,
      adapters: ADAPTERS,
      fetchImpl: async () =>
        new Response(JSON.stringify({ spec }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await t.deps
      .createStateStore(home)
      .setConfig({ token: 'tok_secret', serverUrl: 'https://arena.example' });

    await createProgram({ ...t.deps, createUploader: () => uploader }).parseAsync([
      'node',
      'arena',
      'run',
      '--battle',
      'btl_abcdefgh',
      '--json',
      '--home',
      home,
    ]);

    // The engine runs under the server's id, so the pending battle is the one that completes.
    expect(t.options.at(-1)?.battleId).toBe('btl_abcdefgh');
    expect(uploaderCalls).toEqual([]);
    expect(t.json<{ url: string | null }>().url).toBe('https://arena.example/battles/btl_abcdefgh');
  });
});

describe('arena demo', () => {
  it('runs the demo through runDemoBattle and exports the record and events', async () => {
    const record = fakeRecord({ winner: 'tie' });
    const t = testHarness({ home, adapters: ADAPTERS, record });
    const store = t.deps.createStateStore(home);
    await store.saveRecord(record);
    await store.appendEvents(record.id, []);
    const exportDir = path.join(home, 'exported');

    await run(t, ['demo', '--json', '--export', exportDir, '--home', home]);

    const parsed = t.json<{ status: string; export: { events: number } }>();
    expect(parsed.status).toBe('completed');
    expect(fs.existsSync(path.join(exportDir, 'battle.json'))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, 'events.ndjson'))).toBe(true);
    const exported = fs.readFileSync(path.join(exportDir, 'battle.json'), 'utf8');
    expect(exported).not.toContain(home);
  });
});

describe('arena list / status / replay / open', () => {
  it('lists the newest battles as JSON', async () => {
    const t = harness();
    const record = fakeRecord({ winner: 'a' });
    await t.deps.createStateStore(home).saveRecord(record);
    await run(t, ['list', '--json', '--home', home]);
    const parsed = t.json<{ count: number; battles: Array<{ id: string }> }>();
    expect(parsed.count).toBe(1);
    expect(parsed.battles[0]?.id).toBe(record.id);
  });

  it('status falls back to the newest battle', async () => {
    const t = harness();
    const record = fakeRecord({ winner: 'b' });
    await t.deps.createStateStore(home).saveRecord(record);
    await run(t, ['status', '--json', '--home', home]);
    expect(t.json<{ id: string }>().id).toBe(record.id);
  });

  it('status --watch stops at a terminal battle status', async () => {
    const t = harness();
    const record = fakeRecord({ winner: 'a' });
    const store = t.deps.createStateStore(home);
    await store.saveRecord(record);
    await run(t, ['status', record.id, '--watch', '--json', '--home', home]);
    expect(t.json<{ status: string }>().status).toBe('completed');
  });

  it('status --watch --json prints one JSON document with the events it tailed', async () => {
    const t = harness();
    const record = fakeRecord({ winner: 'a' });
    const store = t.deps.createStateStore(home);
    await store.saveRecord(record);
    await store.appendEvents(record.id, [
      { seq: 1, ts: '2026-09-19T12:00:01.000Z', side: 'a', type: 'run.started' },
      { seq: 2, ts: '2026-09-19T12:00:02.000Z', side: null, type: 'battle.completed' },
    ] as unknown as ArenaEvent[]);

    await run(t, ['status', record.id, '--watch', '--json', '--home', home]);

    // One document, not one per event: `arena status --watch --json | jq` has to parse.
    const parsed = JSON.parse(t.out()) as {
      status: string;
      events: Array<{ seq: number; side: string | null; type: string }>;
    };
    expect(parsed.status).toBe('completed');
    expect(parsed.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(parsed.events[1]?.type).toBe('battle.completed');
  });

  it('replay rebuilds report.html and open serves it to the browser', async () => {
    const t = harness();
    const record = fakeRecord({ winner: 'a' });
    const store = t.deps.createStateStore(home);
    await store.saveRecord(record);
    await run(t, ['replay', record.id, '--json', '--home', home]);
    const reportPath = t.json<{ reportPath: string; bytes: number }>().reportPath;
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('<!doctype html>');
    // --json keeps the browser closed
    expect(t.opened).toHaveLength(0);

    const t2 = harness();
    await run(t2, ['open', record.id, '--home', home]);
    expect(t2.opened).toEqual([reportPath]);
  });

  it('open explains how to rebuild a missing report', async () => {
    const t = harness();
    const record = fakeRecord({ winner: 'a' });
    await t.deps.createStateStore(home).saveRecord(record);
    fs.rmSync(t.deps.createStateStore(home).paths(record.id).report, { force: true });
    await expect(run(t, ['open', record.id, '--home', home])).rejects.toThrow(/arena replay/);
  });
});

describe('arena agents', () => {
  it('reports installed state, versions and the capability summary', async () => {
    const t = harness();
    await run(t, ['agents', '--json']);
    const parsed = t.json<{
      agents: Array<{ id: string; installed: boolean; capabilities: { subagents: string } }>;
    }>();
    expect(parsed.agents.map((agent) => agent.id)).toEqual(['claude-code', 'codex', 'fake']);
    expect(parsed.agents[1]?.installed).toBe(false);
    expect(parsed.agents[0]?.capabilities.subagents).toBe('unavailable');
  });

  it('marks a missing CLI in the human table', async () => {
    const t = harness();
    await run(t, ['agents']);
    expect(t.out()).toContain('Detected agents');
    expect(t.out()).toContain('not installed');
  });
});

describe('arena harnesses', () => {
  it('inspects a local harness and prints the product-style report', async () => {
    const t = harness();
    const dir = path.join(home, 'h');
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'one'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# rules\n');
    fs.writeFileSync(path.join(dir, '.claude', 'skills', 'one', 'SKILL.md'), '# skill\n');
    fs.writeFileSync(path.join(dir, 'arena.yaml'), ['arena: 1', 'name: local-harness', ''].join('\n'));

    await run(t, ['harnesses', 'inspect', dir, '--home', home]);
    const out = t.out();
    expect(out).toContain('Detected Claude Code harness');
    expect(out).toContain('CLAUDE.md');
    expect(out).toContain('Skills');
    expect(out).toContain('No commands would run on your machine.');
    expect(out).toMatch(/Ready to battle|Needs attention/);
  });

  it('inspects a GitHub harness over the API without cloning', async () => {
    const files = {
      sha: 'main',
      tree: [
        { path: 'CLAUDE.md', type: 'blob', size: 12 },
        { path: 'arena.yaml', type: 'blob', size: 40 },
      ],
      truncated: false,
    };
    const urls: string[] = [];
    const t = testHarness({
      home,
      adapters: ADAPTERS,
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('/git/trees/')) {
          return new Response(JSON.stringify(files), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/contents/arena.yaml')) {
          // The file source asks for application/vnd.github.raw+json, so the body is the file itself.
          return new Response('arena: 1\nname: remote-harness\n', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        if (url.endsWith('/repos/owner/harness')) {
          return new Response(JSON.stringify({ default_branch: 'main' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    await run(t, ['harnesses', 'inspect', 'https://github.com/owner/harness', '--json', '--home', home]);
    const parsed = t.json<{ name: string; inspection: { framework: string } }>();
    expect(parsed.name).toBe('remote-harness');
    expect(urls.some((url) => url.startsWith('https://api.github.com/'))).toBe(true);
  });

  it('lists cached harnesses with their source and commit', async () => {
    const t = harness();
    fs.mkdirSync(path.join(home, 'harnesses', 'abc123'), { recursive: true });
    fs.writeFileSync(path.join(home, 'harnesses', 'abc123', 'arena.yaml'), 'arena: 1\nname: cached\n');
    await run(t, ['harnesses', 'list', '--json', '--home', home]);
    const parsed = t.json<{ count: number; harnesses: Array<{ name: string | null }> }>();
    expect(parsed.count).toBe(1);
    expect(parsed.harnesses[0]?.name).toBe('cached');
  });
});

describe('arena doctor and clean', () => {
  it('reports the environment, the scanned volume and orphans', async () => {
    const t = harness();
    const record = fakeRecord({ status: 'running', statusA: 'running', winner: null });
    const store = t.deps.createStateStore(home);
    await store.saveRecord(record);
    fs.mkdirSync(store.paths(record.id).workspaces.a, { recursive: true });
    fs.writeFileSync(
      store.paths(record.id).lock,
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
    );

    await run(t, ['doctor', '--json', '--home', home]);
    const parsed = t.json<{
      battlesScanned: number;
      orphanedWorkspaces: Array<{ battleId: string }>;
      staleLocks: Array<{ battleId: string }>;
    }>();
    expect(parsed.battlesScanned).toBe(1);
    expect(parsed.orphanedWorkspaces[0]?.battleId).toBe(record.id);
    expect(parsed.staleLocks[0]?.battleId).toBe(record.id);

    const t2 = harness();
    await run(t2, ['doctor', '--fix', '--json', '--home', home]);
    expect(fs.existsSync(store.paths(record.id).workspaces.a)).toBe(false);
    expect(fs.existsSync(store.paths(record.id).lock)).toBe(false);
  });

  it('clean removes finished battles older than the cutoff and refuses without confirmation', async () => {
    const t = harness();
    const record = fakeRecord({ winner: 'a' });
    const store = t.deps.createStateStore(home);
    await store.saveRecord(record);

    await expect(run(t, ['clean', '--older-than', '0', '--home', home])).rejects.toThrow(/--yes/);
    expect(fs.existsSync(store.paths(record.id).dir)).toBe(true);

    const t2 = harness();
    await run(t2, ['clean', '--older-than', '0', '--yes', '--json', '--home', home]);
    expect(t2.json<{ removed: string[] }>().removed).toEqual([record.id]);
    expect(fs.existsSync(store.paths(record.id).dir)).toBe(false);
  });
});

describe('arena with no arguments', () => {
  it('prints help when stdout is not a terminal', async () => {
    const t = harness({ isTTY: false });
    await run(t, []);
    expect(t.out()).toContain('Usage: arena');
    expect(t.out()).toContain('battle');
  });
});
