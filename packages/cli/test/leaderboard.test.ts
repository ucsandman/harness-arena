import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../src/program.js';
import { CliError } from '../src/errors.js';
import { removeDir, tempDir, testHarness } from './helpers.js';

/**
 * The read commands (`leaderboard`, `rating`, `profile`, `h2h`, `badge`) against an injected fetch:
 * no server, no network, no battle. What is asserted is the request each command builds, the table it
 * renders, the `--json` shape, that a provisional row is separated from the ranked ones, and that a
 * non-2xx answer becomes exit code 1 carrying the server's own message.
 */

let home: string;

beforeEach(() => {
  home = tempDir('leaderboard');
});

afterEach(() => {
  removeDir(home);
});

const SERVER = 'https://arena.example';

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
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
    });
    const path = url.slice(SERVER.length);
    const answer = routes[path] ?? routes[path.split('?')[0] ?? ''];
    if (!answer) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route ' + path } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

const LEADERBOARD = {
  category: 'overall',
  pool: 'community',
  agentId: null,
  minSample: 10,
  poolEmpty: false,
  entries: [
    entry(),
    entry({ rank: 2, harnessSlug: 'tidy-agent', harnessName: 'Tidy', rating: 1512, deviation: 96 }),
    entry({
      rank: null,
      harnessSlug: 'fresh-harness',
      harnessName: 'Fresh',
      rating: 1500,
      deviation: 320,
      battles: 3,
      wins: 2,
      losses: 1,
      ties: 0,
      provisional: true,
      form: 'WWL',
    }),
  ],
};

const PROFILE = {
  slug: 'superclaude',
  name: 'SuperClaude',
  sourceUrl: 'https://github.com/acme/superclaude',
  sourceKind: 'github',
  description: 'An opinionated Claude Code harness.',
  framework: 'claude-code',
  owner: 'acme',
  ratings: [
    {
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
    },
  ],
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
  lineage: {
    ancestors: [
      {
        harnessSlug: 'superclaude',
        relation: 'forked_from',
        parentSlug: 'base-harness',
        parentSource: 'https://github.com/acme/base-harness',
        evidence: 'github_fork',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    ],
    descendants: [],
  },
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
  filter: { agentId: 'claude-code' },
};

async function run(t: ReturnType<typeof testHarness>, argv: string[]): Promise<void> {
  await createProgram(t.deps).parseAsync(['node', 'arena', ...argv]);
}

/** The CliError a command threw, so its message and exit code can both be asserted. */
async function failure(t: ReturnType<typeof testHarness>, argv: string[]): Promise<CliError> {
  try {
    await run(t, argv);
  } catch (err) {
    expect(err, 'expected a CliError').toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error('the command succeeded; a failure was expected');
}

describe('arena leaderboard', () => {
  it('renders ranked rows, then the provisional rows after a divider', async () => {
    const server = fakeServer({ '/api/v1/leaderboard': { body: LEADERBOARD } });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['leaderboard', '--home', home]);

    const out = t.out();
    expect(out).toContain('Rank');
    expect(out).toContain('superclaude');
    expect(out).toContain('1624');
    // rating and deviation always travel together
    expect(out).toMatch(/1624\s*(±|\+\/-)74/);
    // the sample column carries its threshold
    expect(out).toContain('24/10');
    expect(out).toContain('-- provisional');
    const dividerAt = out.indexOf('-- provisional');
    expect(out.indexOf('fresh-harness')).toBeGreaterThan(dividerAt);
    expect(out.indexOf('superclaude')).toBeLessThan(dividerAt);
    expect(out).toContain('Community ratings come from battles contributors');
    expect(server.calls[0]?.url).toBe(SERVER + '/api/v1/leaderboard');
  });

  it('passes the filters through as query parameters', async () => {
    const server = fakeServer({ '/api/v1/leaderboard': { body: LEADERBOARD } });
    const t = testHarness({ home, fetchImpl: server.fetchImpl });

    await run(t, [
      'leaderboard',
      '--home',
      home,
      '--server',
      SERVER,
      '--category',
      'repo navigation',
      '--pool',
      'verified',
      '--agent',
      'codex',
      '--limit',
      '5',
    ]);

    const url = new URL(server.calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/v1/leaderboard');
    expect(url.searchParams.get('category')).toBe('repo_navigation');
    expect(url.searchParams.get('pool')).toBe('verified');
    expect(url.searchParams.get('agent')).toBe('codex');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('--json prints one document with the entries and the sample threshold', async () => {
    const server = fakeServer({ '/api/v1/leaderboard': { body: LEADERBOARD } });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['leaderboard', '--home', home, '--json']);

    const json = t.json<{
      category: string;
      pool: string;
      minSample: number;
      ranked: number;
      provisional: number;
      entries: unknown[];
      note: string;
    }>();
    expect(json.category).toBe('overall');
    expect(json.pool).toBe('community');
    expect(json.minSample).toBe(10);
    expect(json.ranked).toBe(2);
    expect(json.provisional).toBe(1);
    expect(json.entries).toHaveLength(3);
    expect(json.note).toContain('Community ratings come from battles contributors');
  });

  it('says the verified pool is empty instead of printing an empty table', async () => {
    const server = fakeServer({
      '/api/v1/leaderboard': {
        body: {
          ...LEADERBOARD,
          pool: 'verified',
          poolEmpty: true,
          entries: [],
        },
      },
    });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['leaderboard', '--home', home, '--pool', 'verified']);

    const out = t.out();
    expect(out).toContain('verified pool is empty');
    expect(out).toContain('Arena hosts no runner');
    expect(out).not.toContain('Rank');
  });

  it('exits 1 with the server message on a non-2xx', async () => {
    const server = fakeServer({
      '/api/v1/leaderboard': {
        status: 503,
        body: { error: { code: 'unavailable', message: 'the ratings table is rebuilding' } },
      },
    });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    const err = await failure(t, ['leaderboard', '--home', home]);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('the ratings table is rebuilding');
  });

  it('rejects a category it cannot map without calling the server', async () => {
    const server = fakeServer({ '/api/v1/leaderboard': { body: LEADERBOARD } });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    const err = await failure(t, ['leaderboard', '--home', home, '--category', 'vibes']);
    expect(err.message).toContain('--category must be one of');
    expect(server.calls).toHaveLength(0);
  });
});

describe('arena rating', () => {
  it('prints the current number, the peak and the rates with their denominators', async () => {
    const server = fakeServer({ '/api/v1/harnesses/superclaude': { body: PROFILE } });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['rating', 'superclaude', '--home', home]);

    const out = t.out();
    expect(out).toContain('SuperClaude');
    expect(out).toMatch(/1624\s*(±|\+\/-)74/);
    expect(out).toContain('Peak');
    expect(out).toContain('1650');
    expect(out).toContain('58% of 24');
    expect(out).toContain('WWLTW');
    expect(server.calls).toHaveLength(1);
  });

  it('--history reads the audit trail and prints before and after', async () => {
    const server = fakeServer({
      '/api/v1/harnesses/superclaude': { body: PROFILE },
      '/api/v1/harnesses/superclaude/history': { body: HISTORY },
    });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['rating', 'superclaude', '--home', home, '--history']);

    const out = t.out();
    expect(out).toContain('btl_0000000000000001');
    expect(out).toContain('vanilla');
    expect(out).toContain('1598'); // before: 1610.5 - 12.5
    expect(out).toContain('1611'); // after
    expect(out).toContain('+13');
    const url = new URL(server.calls[1]?.url ?? '');
    expect(url.pathname).toBe('/api/v1/harnesses/superclaude/history');
    expect(url.searchParams.get('agent')).toBe('claude-code');
    expect(url.searchParams.get('pool')).toBe('community');
  });

  it('names what does exist when the asked-for rating does not', async () => {
    const server = fakeServer({ '/api/v1/harnesses/superclaude': { body: PROFILE } });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    const err = await failure(t, ['rating', 'superclaude', '--home', home, '--category', 'frontend']);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('no community rating for frontend');
    expect(err.message).toContain('claude-code/overall/community');
  });

  it('--json carries the ratings and the history points', async () => {
    const server = fakeServer({
      '/api/v1/harnesses/superclaude': { body: PROFILE },
      '/api/v1/harnesses/superclaude/history': { body: HISTORY },
    });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['rating', 'superclaude', '--home', home, '--history', '--json']);

    const json = t.json<{ slug: string; ratings: unknown[]; history: Array<{ battleId: string }> }>();
    expect(json.slug).toBe('superclaude');
    expect(json.ratings).toHaveLength(1);
    expect(json.history[0]?.battleId).toBe('btl_0000000000000001');
  });
});

describe('arena profile', () => {
  it('prints identity, ratings, categories, efficiency, versions, opponents, insights and lineage', async () => {
    const server = fakeServer({ '/api/v1/harnesses/superclaude': { body: PROFILE } });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['profile', 'superclaude', '--home', home]);

    const out = t.out();
    expect(out).toContain('SuperClaude');
    expect(out).toContain('https://github.com/acme/superclaude');
    expect(out).toContain('Ratings');
    expect(out).toContain('debugging');
    expect(out).toContain('0.82x');
    expect(out).toContain('abcdef012345');
    expect(out).toContain('Vanilla');
    expect(out).toContain('Strongest at debugging.');
    expect(out).toContain('(n=12)');
    expect(out).toContain('base-harness');
    expect(out).toContain('github_fork');
    // an unmeasured ratio is n/a, never 0
    expect(out).toContain('n/a');
  });

  it('--json returns the whole profile and the web URL', async () => {
    const server = fakeServer({ '/api/v1/harnesses/superclaude': { body: PROFILE } });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['profile', 'superclaude', '--home', home, '--json']);

    const json = t.json<{ profile: { slug: string; analyzedBattles: number }; url: string }>();
    expect(json.profile.slug).toBe('superclaude');
    expect(json.profile.analyzedBattles).toBe(24);
    expect(json.url).toBe(SERVER + '/harnesses/superclaude');
  });

  it('exits 1 when the harness is unknown', async () => {
    const server = fakeServer({});
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    const err = await failure(t, ['profile', 'nope', '--home', home]);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('harness nope is not there');
  });
});

describe('arena h2h', () => {
  it('prints the record with the win rate over the decided battles', async () => {
    const server = fakeServer({
      '/api/v1/harnesses/superclaude/vs/vanilla': { body: { headToHead: H2H, note: 'community' } },
    });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['h2h', 'superclaude', 'vanilla', '--home', home, '--agent', 'claude-code']);

    const out = t.out();
    expect(out).toContain('SuperClaude vs Vanilla');
    expect(out).toContain('9/4/2');
    expect(out).toContain('60% of 15');
    expect(new URL(server.calls[0]?.url ?? '').searchParams.get('agent')).toBe('claude-code');
  });

  it('accepts a bare head-to-head body as well as a wrapped one', async () => {
    const server = fakeServer({ '/api/v1/harnesses/superclaude/vs/vanilla': { body: H2H } });
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['h2h', 'superclaude', 'vanilla', '--home', home, '--json']);

    const json = t.json<{ headToHead: { wins: number; battles: number } }>();
    expect(json.headToHead.wins).toBe(9);
    expect(json.headToHead.battles).toBe(15);
  });
});

describe('arena badge', () => {
  it('prints the badge URL and a Markdown snippet without calling the server', async () => {
    const server = fakeServer({});
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['badge', 'superclaude', '--home', home]);

    const out = t.out();
    expect(out).toContain(SERVER + '/api/v1/badges/superclaude/rating');
    expect(out).toContain('[![Community rating](' + SERVER + '/api/v1/badges/superclaude/rating)]');
    expect(server.calls).toHaveLength(0);
  });

  it('--markdown prints only the snippet, and --kind selects the badge', async () => {
    const server = fakeServer({});
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    await run(t, ['badge', 'superclaude', '--home', home, '--kind', 'win-rate', '--markdown']);

    const out = t.out().trim();
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toBe(
      '[![Win rate](' +
        SERVER +
        '/api/v1/badges/superclaude/win-rate)](' +
        SERVER +
        '/harnesses/superclaude)',
    );
  });

  it('rejects a badge kind that does not exist', async () => {
    const server = fakeServer({});
    const t = testHarness({ home, env: { ARENA_SERVER_URL: SERVER }, fetchImpl: server.fetchImpl });

    const err = await failure(t, ['badge', 'superclaude', '--home', home, '--kind', 'vibes']);
    expect(err.message).toContain('--kind must be one of');
  });
});
