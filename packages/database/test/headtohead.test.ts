import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArenaDb } from '../src/client.js';
import { benchmarkVersions, benchmarks } from '../src/schema/index.js';
import { getHeadToHead, listOpponents } from '../src/headtohead.js';
import { upsertBattleFromRecord } from '../src/queries.js';
import type { HarnessFixture, RecordFixtureOptions } from './helpers.js';
import { buildRecord, freshDb } from './helpers.js';

const superclaude: HarnessFixture = {
  name: 'superclaude',
  source: 'https://github.com/acme/superclaude',
  kind: 'github',
  commit: 'abc1234def',
};
const superclaudeNext: HarnessFixture = { ...superclaude, commit: 'f00ba12345' };
const rival: HarnessFixture = {
  name: 'rival',
  source: 'https://github.com/acme/rival',
  kind: 'github',
  commit: '9999999',
};

describe('head-to-head', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  async function store(opts: RecordFixtureOptions): Promise<string> {
    const record = buildRecord({ visibility: 'public', ...opts });
    await upsertBattleFromRecord(handle.db, { record });
    return record.id;
  }

  it("counts the pair's real record from either side, and keeps undecided battles visible", async () => {
    // subject on side A twice, on side B twice: two wins, one loss, one tie, one inconclusive
    await store({ harnessA: superclaude, harnessB: rival, winner: 'a' });
    await store({ harnessA: superclaude, harnessB: rival, winner: 'b', repositoryCommit: 'aaaaaaa1' });
    await store({ harnessA: rival, harnessB: superclaude, winner: 'b', repositoryCommit: 'aaaaaaa2' });
    await store({ harnessA: rival, harnessB: superclaude, winner: 'tie', repositoryCommit: 'aaaaaaa3' });
    await store({
      harnessA: superclaude,
      harnessB: rival,
      winner: 'inconclusive',
      repositoryCommit: 'aaaaaaa4',
    });

    const h2h = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {});
    expect(h2h).not.toBeNull();
    expect(h2h).toMatchObject({
      subject: { slug: 'acme--superclaude' },
      opponent: { slug: 'acme--rival' },
      wins: 2,
      losses: 1,
      ties: 1,
      inconclusive: 1,
      battles: 4,
    });
    expect(h2h?.winRate).toBeCloseTo(0.5, 10);
    expect(h2h?.recentBattleIds).toHaveLength(5);
    expect(h2h?.lastBattleAt).toBeTruthy();

    // the mirror view is the same battles with wins and losses swapped
    const mirror = await getHeadToHead(handle.db, 'acme--rival', 'acme--superclaude', {});
    expect(mirror).toMatchObject({ wins: 1, losses: 2, ties: 1, inconclusive: 1, battles: 4 });
  });

  it('returns null when either harness is unknown', async () => {
    await store({ harnessA: superclaude, harnessB: rival });
    expect(await getHeadToHead(handle.db, 'acme--superclaude', 'nope', {})).toBeNull();
    expect(await getHeadToHead(handle.db, 'nope', 'acme--rival', {})).toBeNull();
  });

  it('only counts public, completed battles', async () => {
    await store({ harnessA: superclaude, harnessB: rival, winner: 'a' });
    await store({
      harnessA: superclaude,
      harnessB: rival,
      winner: 'a',
      visibility: 'private',
      repositoryCommit: 'bbbbbbb1',
    });
    await store({
      harnessA: superclaude,
      harnessB: rival,
      winner: 'a',
      status: 'failed',
      repositoryCommit: 'bbbbbbb2',
    });

    const h2h = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {});
    expect(h2h?.battles).toBe(1);
  });

  it('filters by agent, category, pool, commit prefix and date range', async () => {
    await store({
      harnessA: superclaude,
      harnessB: rival,
      winner: 'a',
      category: 'debugging',
      createdAt: '2026-08-01T10:00:00.000Z',
    });
    await store({
      harnessA: superclaudeNext,
      harnessB: rival,
      winner: 'b',
      category: 'refactoring',
      repositoryCommit: 'ccccccc1',
      createdAt: '2026-09-01T10:00:00.000Z',
    });
    await store({
      harnessA: superclaude,
      harnessB: rival,
      winner: 'a',
      agentA: 'codex',
      agentB: 'codex',
      repositoryCommit: 'ccccccc2',
      eligible: true,
      verificationKind: 'cloud',
      createdAt: '2026-09-10T10:00:00.000Z',
    });

    const all = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {});
    expect(all?.battles).toBe(3);

    const byAgent = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {
      agentId: 'codex',
    });
    expect(byAgent?.battles).toBe(1);
    expect(byAgent?.wins).toBe(1);

    const byCategory = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {
      category: 'debugging',
    });
    expect(byCategory?.battles).toBe(1);
    // `overall` is every battle, exactly as the ratings count them
    const overall = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {
      category: 'overall',
    });
    expect(overall?.battles).toBe(3);

    const verified = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {
      pool: 'verified',
    });
    expect(verified?.battles).toBe(1);
    const community = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {
      pool: 'community',
    });
    expect(community?.battles).toBe(2);

    const byCommit = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {
      commit: 'f00ba',
    });
    expect(byCommit?.battles).toBe(1);
    expect(byCommit?.losses).toBe(1);

    const window = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {
      since: '2026-08-15T00:00:00.000Z',
      until: '2026-09-05T00:00:00.000Z',
    });
    expect(window?.battles).toBe(1);
    expect(window?.filter.since).toBe('2026-08-15T00:00:00.000Z');
  });

  it('filters by benchmark pack', async () => {
    await handle.db.insert(benchmarks).values({
      id: 'bmk_0000000000000001',
      slug: 'debug-pack',
      name: 'Debug pack',
    });
    await handle.db.insert(benchmarkVersions).values({
      id: 'bmv_0123456789abcdef01234567',
      benchmarkId: 'bmk_0000000000000001',
      version: '1.0.0',
      pack: {} as never,
      taskCount: 1,
      battlesPerRun: 1,
      categories: ['debugging'],
    });

    await store({
      harnessA: superclaude,
      harnessB: rival,
      winner: 'a',
      benchmark: {
        slug: 'debug-pack',
        versionId: 'bmv_0123456789abcdef01234567',
        version: '1.0.0',
        taskId: 'fix-null-deref',
      },
    });
    await store({ harnessA: superclaude, harnessB: rival, winner: 'b', repositoryCommit: 'ddddddd1' });

    const packed = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {
      benchmarkSlug: 'debug-pack',
    });
    expect(packed?.battles).toBe(1);
    expect(packed?.wins).toBe(1);

    const missing = await getHeadToHead(handle.db, 'acme--superclaude', 'acme--rival', {
      benchmarkSlug: 'other-pack',
    });
    expect(missing?.battles).toBe(0);
    expect(missing?.winRate).toBeNull();
  });

  it('lists the opponents a harness actually fought, most battles first', async () => {
    await store({ harnessA: superclaude, harnessB: rival, winner: 'a' });
    await store({ harnessA: superclaude, harnessB: rival, winner: 'a', repositoryCommit: 'eeeeeee1' });
    await store({ harnessA: superclaude, winner: 'b', repositoryCommit: 'eeeeeee2' });

    const opponents = await listOpponents(handle.db, 'acme--superclaude');
    expect(opponents.map((entry) => entry.slug)).toEqual(['acme--rival', 'vanilla']);
    expect(opponents[0]).toMatchObject({ battles: 2, wins: 2, losses: 0, ties: 0 });
    expect(opponents[1]).toMatchObject({ battles: 1, wins: 0, losses: 1 });
    expect(opponents[0]?.lastBattleAt).toBeTruthy();

    expect(await listOpponents(handle.db, 'nope')).toEqual([]);
    expect(await listOpponents(handle.db, 'acme--superclaude', 1)).toHaveLength(1);
  });
});
