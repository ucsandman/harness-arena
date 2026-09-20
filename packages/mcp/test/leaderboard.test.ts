import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStateStore } from '@harness-arena/core';
import { callTool, connect, removeDir, tempDir, type Connected } from './helpers.js';

/**
 * The five read tools against an injected fetch: no server, no network, no battle. What is asserted is
 * the refusal when no server is configured, the request each tool builds, the honesty language in the
 * descriptions, and that a number never comes back without the sample behind it.
 */

const SERVER = 'https://arena.example';
const TOKEN = 'tok_test';

interface Call {
  url: string;
  method: string;
  auth: string | null;
}

function fakeServer(routes: Record<string, { status?: number; body: unknown }>): {
  fetchImpl: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
    });
    const path = url.slice(SERVER.length);
    const answer = routes[path] ?? routes[path.split('?')[0] ?? ''];
    if (!answer) {
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'no route ' + path } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const RATING = {
  agentId: 'claude-code',
  category: 'overall',
  pool: 'community',
  rating: 1624.4,
  deviation: 74.2,
  peakRating: 1650.1,
  battles: 24,
  wins: 14,
  losses: 7,
  ties: 3,
  provisional: false,
  form: 'WWLTW',
  lastBattleAt: '2026-09-18T10:00:00.000Z',
};

const LEADERBOARD = {
  category: 'overall',
  pool: 'community',
  agentId: null,
  minSample: 10,
  poolEmpty: false,
  entries: [
    {
      rank: 1,
      harnessSlug: 'superclaude',
      harnessName: 'SuperClaude',
      agentId: 'claude-code',
      rating: 1624.4,
      deviation: 74.2,
      peakRating: 1650.1,
      battles: 24,
      wins: 14,
      losses: 7,
      ties: 3,
      provisional: false,
      form: 'WWLTW',
      lastBattleAt: '2026-09-18T10:00:00.000Z',
    },
    {
      rank: null,
      harnessSlug: 'fresh-harness',
      harnessName: 'Fresh',
      agentId: 'claude-code',
      rating: 1500,
      deviation: 320,
      peakRating: 1500,
      battles: 3,
      wins: 2,
      losses: 1,
      ties: 0,
      provisional: true,
      form: 'WWL',
      lastBattleAt: '2026-09-18T10:00:00.000Z',
    },
  ],
};

const PROFILE = {
  slug: 'superclaude',
  name: 'SuperClaude',
  sourceUrl: 'https://github.com/acme/superclaude',
  sourceKind: 'github',
  description: null,
  framework: 'claude-code',
  owner: 'acme',
  ratings: [RATING],
  versions: [
    {
      id: 'hv_0000000000000001',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      createdAt: '2026-09-01T10:00:00.000Z',
      battles: 24,
      wins: 14,
      losses: 7,
      ties: 3,
    },
  ],
  categoryPerformance: [
    {
      category: 'debugging',
      battles: 12,
      wins: 8,
      losses: 3,
      ties: 1,
      correctnessRate: 0.75,
      correctnessBattles: 12,
    },
  ],
  efficiencyProfile: {
    tokens: { medianRatio: 0.82, n: 18 },
    cost: { medianRatio: null, n: 0 },
    duration: { medianRatio: 1.1, n: 18 },
  },
  recentBattles: [],
  opponents: [{ slug: 'vanilla', name: 'Vanilla', wins: 9, losses: 4, ties: 2 }],
  lineage: { ancestors: [], descendants: [] },
  insights: [{ kind: 'category_strength', text: 'Strongest at debugging.', n: 12 }],
  challenges: 2,
  analyzedBattles: 24,
};

const HISTORY = {
  slug: 'superclaude',
  agentId: 'claude-code',
  category: 'overall',
  pool: 'community',
  points: [
    {
      battleId: 'btl_0000000000000001',
      at: '2026-09-17T10:00:00.000Z',
      rating: 1610.5,
      deviation: 80,
      delta: 12.5,
      outcome: 'win',
      opponentSlug: 'vanilla',
      harnessCommit: 'abcdef0123456789',
    },
  ],
};

const H2H = {
  subject: { slug: 'superclaude', name: 'SuperClaude' },
  opponent: { slug: 'vanilla', name: 'Vanilla' },
  wins: 9,
  losses: 4,
  ties: 2,
  inconclusive: 1,
  battles: 15,
  winRate: 0.6,
  lastBattleAt: '2026-09-18T10:00:00.000Z',
  recentBattleIds: ['btl_0000000000000001'],
  filter: {},
};

const ROUTES = {
  '/api/v1/leaderboard': { body: LEADERBOARD },
  '/api/v1/harnesses/superclaude': { body: PROFILE },
  '/api/v1/harnesses/superclaude/history': { body: HISTORY },
  '/api/v1/harnesses/superclaude/vs/vanilla': { body: { headToHead: H2H } },
};

let home: string;
let session: Connected | null = null;

beforeEach(() => {
  home = tempDir('leaderboard');
});

afterEach(async () => {
  if (session) await session.close();
  session = null;
  removeDir(home);
});

async function storeServer(): Promise<void> {
  await createStateStore(home).setConfig({ token: TOKEN, serverUrl: SERVER });
}

describe('leaderboard tools', () => {
  it('are listed and say the results are community-reported', async () => {
    session = await connect({ home, env: {}, deps: { exampleHarnessDir: null } });
    const listed = await session.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    for (const name of [
      'arena_get_leaderboard',
      'arena_get_harness_profile',
      'arena_get_rating',
      'arena_get_head_to_head',
      'arena_get_insights',
    ]) {
      expect(byName.has(name), name + ' is not registered').toBe(true);
      expect(byName.get(name)?.description).toContain('community-reported');
      expect(byName.get(name)?.description).toContain('/docs/ratings');
    }
  });

  it('refuse with a clear message when no server is configured, and fetch nothing', async () => {
    const server = fakeServer(ROUTES);
    session = await connect({
      home,
      env: {},
      deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl },
    });

    const answer = await callTool(session.client, 'arena_get_leaderboard', {});
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('ARENA_SERVER_URL');
    expect(answer.text).toContain('arena login');
    expect(server.calls).toHaveLength(0);
  });

  it('take the server from ARENA_SERVER_URL without a login', async () => {
    const server = fakeServer(ROUTES);
    session = await connect({
      home,
      env: { ARENA_SERVER_URL: SERVER + '/' },
      deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl },
    });

    const answer = await callTool(session.client, 'arena_get_leaderboard', { category: 'debugging' });
    expect(answer.isError).toBe(false);
    expect(answer.data.minSample).toBe(10);
    expect(answer.data.ranked).toBe(1);
    expect(answer.data.provisional).toBe(1);
    const url = new URL(server.calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/v1/leaderboard');
    expect(url.searchParams.get('category')).toBe('debugging');
    // no login here, so no authorization header
    expect(server.calls[0]?.auth).toBe(null);
  });

  it('fall back to the CLI config and attach the stored token, never returning it', async () => {
    const server = fakeServer(ROUTES);
    await storeServer();
    session = await connect({
      home,
      env: {},
      deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl },
    });

    const answer = await callTool(session.client, 'arena_get_harness_profile', { slug: 'superclaude' });
    expect(answer.isError).toBe(false);
    expect(answer.data.profile.slug).toBe('superclaude');
    expect(answer.data.profile.analyzedBattles).toBe(24);
    expect(server.calls[0]?.auth).toBe('Bearer ' + TOKEN);
    expect(answer.text).not.toContain(TOKEN);
  });

  it('arena_get_rating returns the row and, on request, the audit trail', async () => {
    const server = fakeServer(ROUTES);
    session = await connect({
      home,
      env: { ARENA_SERVER_URL: SERVER },
      deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl },
    });

    const plain = await callTool(session.client, 'arena_get_rating', { slug: 'superclaude' });
    expect(plain.isError).toBe(false);
    expect(plain.data.ratings).toHaveLength(1);
    expect(plain.data.history).toBeUndefined();
    expect(plain.summary).toContain('1624');

    const withHistory = await callTool(session.client, 'arena_get_rating', {
      slug: 'superclaude',
      history: true,
    });
    expect(withHistory.data.history).toHaveLength(1);
    expect(withHistory.data.history[0].battleId).toBe('btl_0000000000000001');
    expect(withHistory.data.historyTruncated).toBe(false);
    const historyUrl = new URL(server.calls.at(-1)?.url ?? '');
    expect(historyUrl.pathname).toBe('/api/v1/harnesses/superclaude/history');
    expect(historyUrl.searchParams.get('agent')).toBe('claude-code');
  });

  it('arena_get_rating refuses a rating row that does not exist', async () => {
    const server = fakeServer(ROUTES);
    session = await connect({
      home,
      env: { ARENA_SERVER_URL: SERVER },
      deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl },
    });

    const answer = await callTool(session.client, 'arena_get_rating', {
      slug: 'superclaude',
      category: 'frontend',
    });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('no community rating for frontend');
  });

  it('arena_get_head_to_head returns the record with its filters', async () => {
    const server = fakeServer(ROUTES);
    session = await connect({
      home,
      env: { ARENA_SERVER_URL: SERVER },
      deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl },
    });

    const answer = await callTool(session.client, 'arena_get_head_to_head', {
      slug: 'superclaude',
      opponent: 'vanilla',
      agentId: 'claude-code',
    });
    expect(answer.isError).toBe(false);
    expect(answer.data.headToHead.wins).toBe(9);
    expect(answer.data.headToHead.battles).toBe(15);
    expect(answer.summary).toContain('15 decided battles');
    expect(new URL(server.calls[0]?.url ?? '').searchParams.get('agent')).toBe('claude-code');
  });

  it('arena_get_insights carries the sample behind every sentence', async () => {
    const server = fakeServer(ROUTES);
    session = await connect({
      home,
      env: { ARENA_SERVER_URL: SERVER },
      deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl },
    });

    const answer = await callTool(session.client, 'arena_get_insights', { slug: 'superclaude' });
    expect(answer.isError).toBe(false);
    expect(answer.data.insights[0].n).toBe(12);
    expect(answer.data.analyzedBattles).toBe(24);
    expect(answer.summary).toContain('24 decided battles');
  });

  it('report the server error rather than an answer of their own', async () => {
    const server = fakeServer({
      '/api/v1/leaderboard': {
        status: 503,
        body: { error: { code: 'unavailable', message: 'the ratings table is rebuilding' } },
      },
    });
    session = await connect({
      home,
      env: { ARENA_SERVER_URL: SERVER },
      deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl },
    });

    const answer = await callTool(session.client, 'arena_get_leaderboard', {});
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('the ratings table is rebuilding');

    const missing = await callTool(session.client, 'arena_get_harness_profile', { slug: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('no harness nope');
  });
});
