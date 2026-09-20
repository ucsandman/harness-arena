import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { battleSpecSchema } from '@harness-arena/protocol';
import type { BattleSpec, BattleSpecInput } from '@harness-arena/protocol';
import type { Uploader } from '@harness-arena/core';
import { createProgram } from '../src/program.js';
import { removeDir, stubAdapter, tempDir, testHarness } from './helpers.js';

/**
 * `arena challenge` and `arena tournament` against an injected fetch: no server, no agent CLI, no
 * network. What is asserted is what the server received, what spec the engine was handed (above all
 * `spec.arena`, which is how a battle is linked), and that the device token never reaches the output.
 */

let home: string;

beforeEach(() => {
  home = tempDir('challenge');
});

afterEach(() => {
  removeDir(home);
});

const ADAPTERS = [stubAdapter({ id: 'fake', displayName: 'Fake agent' })];
const SERVER = 'https://arena.example';
const TOKEN = 'tok_test';

const UPLOADER: Uploader = {
  createBattle: async (record) => ({
    id: record.id,
    url: SERVER + '/battles/' + record.id,
    streamUrl: SERVER + '/api/v1/battles/' + record.id + '/stream',
  }),
  pushEvents: async () => {},
  patchRecord: async () => {},
  uploadArtifact: async () => {},
  flush: async () => {},
  stats: () => ({ batches: 0, events: 0, artifacts: 0, records: 0, failures: 0, skipped: 0 }),
};

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

/** A fake Arena server: routes answered from `routes`, everything else a 404 API error. */
function fakeServer(routes: Record<string, (call: Call) => { status?: number; body: unknown }>): {
  fetchImpl: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
      auth: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const key = call.method + ' ' + url.slice(SERVER.length);
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route ' + key } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const answer = handler(call);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const NOTE = 'Arena hosts no runner.';

const TASK_TARGET = {
  kind: 'task',
  category: 'overall',
  task: { kind: 'prompt', prompt: 'Fix the parser.' },
  repository: { source: 'empty', submodules: false },
  evaluation: { assertions: [], efficiency: {}, judge: { enabled: false } },
  limits: { timeoutMs: 1_200_000, maxOutputBytes: 52_428_800 },
};

function challengeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    challenge: {
      id: 'chl_0000000000000001',
      title: 'superclaude vs vanilla',
      description: null,
      status: 'accepted',
      createdBy: { id: 'usr_1', login: 'creator' },
      sides: {
        a: {
          label: 'superclaude',
          harness: { source: 'https://github.com/acme/superclaude', trusted: false },
        },
        b: { label: 'vanilla', harness: { source: 'vanilla', trusted: false } },
      },
      agent: { id: 'fake' },
      target: TASK_TARGET,
      privacy: { upload: 'metrics', exclude: [], redact: true },
      visibility: 'public',
      ratingEligible: true,
      battleIds: [],
      acceptedBy: { id: 'usr_2', login: 'runner' },
      createdAt: '2026-09-19T10:00:00.000Z',
      expiresAt: null,
      completedAt: null,
      ...overrides,
    },
    url: SERVER + '/challenges/chl_0000000000000001',
    note: NOTE,
  };
}

function writeTask(): string {
  const file = path.join(home, 'task.md');
  fs.writeFileSync(file, 'Fix the parser.\n');
  return file;
}

async function login(t: ReturnType<typeof testHarness>): Promise<void> {
  await t.deps.createStateStore(home).setConfig({ token: TOKEN, serverUrl: SERVER });
}

async function run(
  t: ReturnType<typeof testHarness>,
  argv: string[],
  extras: Partial<Parameters<typeof createProgram>[0]> = {},
): Promise<void> {
  await createProgram({ ...t.deps, ...extras }).parseAsync(['node', 'arena', ...argv]);
}

function lastSpec(t: ReturnType<typeof testHarness>): BattleSpec {
  const spec = t.specs.at(-1);
  expect(spec, 'runBattle was never called').toBeDefined();
  return battleSpecSchema.parse(spec as BattleSpecInput);
}

describe('arena challenge create', () => {
  it('posts the definition with the device token and prints the challenge URL', async () => {
    const server = fakeServer({
      'POST /api/v1/challenges': () => ({ status: 201, body: challengeBody({ status: 'open' }) }),
    });
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await login(t);

    await run(t, [
      'challenge',
      'create',
      '--a',
      'https://github.com/acme/superclaude',
      '--b',
      'vanilla',
      '--agent',
      'fake',
      '--task',
      writeTask(),
      '--repo',
      'empty',
      '--title',
      'superclaude vs vanilla',
      '--json',
      '--home',
      home,
    ]);

    const posted = server.calls.at(-1);
    expect(posted?.method).toBe('POST');
    expect(posted?.auth).toBe('Bearer ' + TOKEN);
    const body = posted?.body as {
      sides: { a: { harness: { source: string } }; b: { harness: { source: string } } };
      agent: { id: string };
      target: { kind: string; task: { prompt: string } };
      ratingEligible: boolean;
    };
    expect(body.sides.a.harness.source).toBe('https://github.com/acme/superclaude');
    expect(body.sides.b.harness.source).toBe('vanilla');
    expect(body.agent.id).toBe('fake');
    expect(body.target.kind).toBe('task');
    expect(body.target.task.prompt).toContain('Fix the parser');
    expect(body.ratingEligible).toBe(true);

    const printed = t.json<{ id: string; url: string }>();
    expect(printed.id).toBe('chl_0000000000000001');
    expect(printed.url).toBe(SERVER + '/challenges/chl_0000000000000001');
    // nothing ran: creating a challenge executes no battle
    expect(t.specs).toHaveLength(0);
    expect(t.out() + t.err()).not.toContain(TOKEN);
  });

  it('--no-rating reaches the server', async () => {
    const server = fakeServer({
      'POST /api/v1/challenges': () => ({ status: 201, body: challengeBody({ status: 'open' }) }),
    });
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await login(t);
    await run(t, [
      'challenge',
      'create',
      '--a',
      'vanilla',
      '--b',
      'vanilla',
      '--agent',
      'fake',
      '--task',
      writeTask(),
      '--repo',
      'empty',
      '--no-rating',
      '--json',
      '--home',
      home,
    ]);
    expect((server.calls.at(-1)?.body as { ratingEligible: boolean }).ratingEligible).toBe(false);
  });

  it('refuses without a login and names `arena login`', async () => {
    const server = fakeServer({});
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await expect(
      run(t, [
        'challenge',
        'create',
        '--a',
        'vanilla',
        '--b',
        'vanilla',
        '--agent',
        'fake',
        '--task',
        writeTask(),
        '--repo',
        'empty',
        '--home',
        home,
      ]),
    ).rejects.toThrow(/arena login/);
    expect(server.calls).toHaveLength(0);
  });

  it('rejects a --benchmark value without a version id', async () => {
    const server = fakeServer({});
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await login(t);
    await expect(
      run(t, [
        'challenge',
        'create',
        '--a',
        'vanilla',
        '--b',
        'vanilla',
        '--agent',
        'fake',
        '--benchmark',
        'acme-pack',
        '--home',
        home,
      ]),
    ).rejects.toThrow(/slug>@<versionId/);
  });
});

describe('arena challenge list', () => {
  it('renders the server list as JSON', async () => {
    const server = fakeServer({
      'GET /api/v1/challenges?status=open': () => ({
        body: { challenges: [challengeBody({ status: 'open' }).challenge], count: 1, note: NOTE },
      }),
    });
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await login(t);
    await run(t, ['challenge', 'list', '--status', 'open', '--json', '--home', home]);
    const printed = t.json<{ challenges: Array<{ id: string }>; count: number }>();
    expect(printed.count).toBe(1);
    expect(printed.challenges[0]?.id).toBe('chl_0000000000000001');
  });

  it('refuses an unknown --status before asking the server', async () => {
    const server = fakeServer({});
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await expect(run(t, ['challenge', 'list', '--status', 'nonsense', '--home', home])).rejects.toThrow(
      /--status must be one of/,
    );
    expect(server.calls).toHaveLength(0);
  });
});

describe('arena challenge run', () => {
  it('accepts the challenge and runs a battle carrying spec.arena.challengeId', async () => {
    const server = fakeServer({
      'GET /api/v1/challenges/chl_0000000000000001': () => ({ body: challengeBody({ status: 'open' }) }),
      'POST /api/v1/challenges/chl_0000000000000001/accept': () => ({ body: challengeBody() }),
    });
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await login(t);

    await run(t, ['challenge', 'run', 'chl_0000000000000001', '--json', '--home', home], {
      createUploader: () => UPLOADER,
    });

    expect(server.calls.map((call) => call.method + ' ' + call.url.slice(SERVER.length))).toEqual([
      'GET /api/v1/challenges/chl_0000000000000001',
      'POST /api/v1/challenges/chl_0000000000000001/accept',
    ]);
    const spec = lastSpec(t);
    expect(spec.arena?.challengeId).toBe('chl_0000000000000001');
    expect(spec.competitors.a.harness.source).toBe('https://github.com/acme/superclaude');
    expect(spec.competitors.b.harness.source).toBe('vanilla');
    expect(spec.competitors.a.agent.id).toBe('fake');
    expect(spec.privacy.upload).toBe('metrics');
    expect(t.json<{ battles: Array<{ id: string }> }>().battles).toHaveLength(1);
    expect(t.out() + t.err()).not.toContain(TOKEN);
  });

  it('--upload none warns that the challenge will not complete', async () => {
    const server = fakeServer({
      'GET /api/v1/challenges/chl_0000000000000001': () => ({ body: challengeBody({ status: 'open' }) }),
      'POST /api/v1/challenges/chl_0000000000000001/accept': () => ({ body: challengeBody() }),
    });
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await login(t);
    await run(t, ['challenge', 'run', 'chl_0000000000000001', '--upload', 'none', '--home', home]);
    expect(t.err()).toMatch(/will not complete/);
    expect(lastSpec(t).privacy.upload).toBe('none');
  });

  it('refuses a benchmark target the server does not serve, naming the pack', async () => {
    const benchmarkChallenge = challengeBody({
      status: 'open',
      target: { kind: 'benchmark', slug: 'acme-pack', versionId: 'bmv_0123456789abcdef01234567' },
    });
    const server = fakeServer({
      'GET /api/v1/challenges/chl_0000000000000001': () => ({ body: benchmarkChallenge }),
      'POST /api/v1/challenges/chl_0000000000000001/accept': () => ({ body: benchmarkChallenge }),
    });
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await login(t);

    await expect(
      run(t, ['challenge', 'run', 'chl_0000000000000001', '--home', home], {
        createUploader: () => UPLOADER,
      }),
    ).rejects.toThrow(/acme-pack@bmv_0123456789abcdef01234567/);
    // it refused instead of running something else
    expect(t.specs).toHaveLength(0);
  });

  it('refuses to run a cancelled challenge', async () => {
    const server = fakeServer({
      'GET /api/v1/challenges/chl_0000000000000001': () => ({
        body: challengeBody({ status: 'cancelled' }),
      }),
    });
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await login(t);
    await expect(run(t, ['challenge', 'run', 'chl_0000000000000001', '--home', home])).rejects.toThrow(
      /cancelled/,
    );
  });
});

// ---- tournaments ---------------------------------------------------------------------------------

function tournamentBody(
  matches: Array<Record<string, unknown>>,
  status = 'running',
): Record<string, unknown> {
  return {
    tournament: {
      id: 'trn_0000000000000001',
      slug: 'cup-abc123',
      name: 'Harness cup',
      description: null,
      format: 'single_elimination',
      status,
      createdBy: null,
      agent: { id: 'fake' },
      target: TASK_TARGET,
      entrants: [
        {
          index: 0,
          label: 'superclaude',
          harness: { source: 'https://github.com/acme/superclaude', trusted: false },
          harnessSlug: 'acme--superclaude',
          seed: 1,
        },
        {
          index: 1,
          label: 'vanilla',
          harness: { source: 'vanilla', trusted: false },
          harnessSlug: 'vanilla',
          seed: 2,
        },
      ],
      rounds: [{ index: 0, matches }],
      winner: null,
      visibility: 'public',
      createdAt: '2026-09-19T10:00:00.000Z',
      startedAt: '2026-09-19T10:01:00.000Z',
      completedAt: null,
    },
    url: SERVER + '/tournaments/cup-abc123',
    note: NOTE,
  };
}

const PENDING_MATCH = {
  id: 'tmt_0000000000000001',
  round: 0,
  position: 0,
  a: 0,
  b: 1,
  bye: false,
  battleIds: [],
  winner: null,
  settledBy: null,
};

describe('arena tournament', () => {
  it('show prints the bracket and the pending count', async () => {
    const server = fakeServer({
      'GET /api/v1/tournaments/cup-abc123': () => ({ body: tournamentBody([PENDING_MATCH]) }),
    });
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await run(t, ['tournament', 'show', 'cup-abc123', '--json', '--home', home]);
    const printed = t.json<{ pending: number; tournament: { name: string } }>();
    expect(printed.pending).toBe(1);
    expect(printed.tournament.name).toBe('Harness cup');
  });

  it('play runs each pending match with its match id and stops when none remain', async () => {
    let fetched = 0;
    const settled = { ...PENDING_MATCH, battleIds: ['btl_x'], winner: 0, settledBy: 'verdict' as const };
    const server = fakeServer({
      'GET /api/v1/tournaments/trn_0000000000000001': () => {
        fetched += 1;
        return { body: tournamentBody([fetched === 1 ? PENDING_MATCH : settled]) };
      },
    });
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await login(t);

    await run(t, ['tournament', 'play', 'trn_0000000000000001', '--json', '--home', home], {
      createUploader: () => UPLOADER,
    });

    // one pass that played the match, one pass that found nothing pending
    expect(fetched).toBe(2);
    expect(t.specs).toHaveLength(1);
    const spec = lastSpec(t);
    expect(spec.arena?.tournamentMatchId).toBe('tmt_0000000000000001');
    // slot order is exact: entrant A must run as side A or the server refuses the link
    expect(spec.competitors.a.harness.source).toBe('https://github.com/acme/superclaude');
    expect(spec.competitors.b.harness.source).toBe('vanilla');
    const printed = t.json<{ played: Array<{ matchId: string }>; remaining: number }>();
    expect(printed.played).toHaveLength(1);
    expect(printed.remaining).toBe(0);
    expect(t.out() + t.err()).not.toContain(TOKEN);
  });

  it('play needs a login, because a match settles only when the battle is uploaded', async () => {
    const server = fakeServer({});
    const t = testHarness({ home, adapters: ADAPTERS, fetchImpl: server.fetchImpl });
    await expect(run(t, ['tournament', 'play', 'cup-abc123', '--home', home])).rejects.toThrow(/arena login/);
    expect(server.calls).toHaveLength(0);
  });
});
