import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { RATING_DEFAULT, RATING_MIN_SAMPLE } from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import { ratingEvents, ratings } from '../src/schema/index.js';
import {
  applyBattleToRatings,
  deviationFor,
  expectedScore,
  getLeaderboard,
  initialRatingState,
  isProvisional,
  mapCategory,
  poolForRecord,
  ratingCategoriesFor,
  updateRating,
} from '../src/ratings.js';
import { getHarnessBySlug, upsertBattleFromRecord } from '../src/queries.js';
import { buildRecord, freshDb } from './helpers.js';

const superclaude = {
  name: 'superclaude',
  source: 'https://github.com/acme/superclaude',
  kind: 'github' as const,
  commit: 'abc1234',
};

describe('rating math', () => {
  it('expected score is symmetric and 0.5 for equal ratings', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1600, 1400) + expectedScore(1400, 1600)).toBeCloseTo(1, 10);
    expect(expectedScore(1800, 1500)).toBeGreaterThan(0.5);
  });

  it('a win raises the rating, a loss lowers it, and a tie between equals is neutral', () => {
    const state = initialRatingState();
    const won = updateRating(state, RATING_DEFAULT, 'win');
    const lost = updateRating(state, RATING_DEFAULT, 'loss');
    const tied = updateRating(state, RATING_DEFAULT, 'tie');

    expect(won.rating).toBeCloseTo(RATING_DEFAULT + 16, 6);
    expect(lost.rating).toBeCloseTo(RATING_DEFAULT - 16, 6);
    expect(tied.rating).toBeCloseTo(RATING_DEFAULT, 6);
    expect(won.wins).toBe(1);
    expect(lost.losses).toBe(1);
    expect(tied.ties).toBe(1);
    expect(won.battles).toBe(1);
  });

  it('deviation shrinks with games and never goes below the floor', () => {
    expect(deviationFor(0)).toBeCloseTo(350, 6);
    expect(deviationFor(10)).toBeLessThan(deviationFor(1));
    expect(deviationFor(1_000_000)).toBe(50);
  });

  it('flags provisional ratings below the minimum sample', () => {
    expect(isProvisional(0)).toBe(true);
    expect(isProvisional(RATING_MIN_SAMPLE - 1)).toBe(true);
    expect(isProvisional(RATING_MIN_SAMPLE)).toBe(false);
    expect(updateRating(initialRatingState(), 1500, 'win').provisional).toBe(true);
  });

  it('maps spec categories onto known rating categories', () => {
    expect(mapCategory('debugging')).toBe('debugging');
    expect(mapCategory('Long Horizon')).toBe('long_horizon');
    expect(mapCategory('made up')).toBe('overall');
    expect(mapCategory(null)).toBe('overall');
    expect(ratingCategoriesFor('debugging')).toEqual(['overall', 'debugging']);
    expect(ratingCategoriesFor(undefined)).toEqual(['overall']);
  });

  it('never promotes a battle into the verified pool without eligibility', () => {
    const local = buildRecord({ eligible: false });
    const verified = buildRecord({ eligible: true, verificationKind: 'cloud' });
    expect(poolForRecord(local)).toBe('community');
    expect(poolForRecord(local, 'verified')).toBe('community');
    expect(poolForRecord(verified)).toBe('verified');
    expect(poolForRecord(verified, 'community')).toBe('community');
  });
});

describe('applyBattleToRatings', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it('moves both sides in every category and is idempotent per battle', async () => {
    const record = buildRecord({
      visibility: 'public',
      category: 'debugging',
      harnessA: superclaude,
      winner: 'a',
    });
    await upsertBattleFromRecord(handle.db, { record });

    const applied = await applyBattleToRatings(handle.db, record);
    expect(applied.applied).toBe(true);
    expect(applied.pool).toBe('community');
    expect(applied.categories).toEqual(['overall', 'debugging']);
    expect(applied.changes).toHaveLength(4);

    const winnerHarness = await getHarnessBySlug(handle.db, 'acme--superclaude');
    const loserHarness = await getHarnessBySlug(handle.db, 'vanilla');
    const rows = await handle.db.select().from(ratings);
    expect(rows).toHaveLength(4);

    const winnerOverall = rows.find(
      (row) => row.harnessId === winnerHarness?.id && row.category === 'overall',
    );
    const loserOverall = rows.find((row) => row.harnessId === loserHarness?.id && row.category === 'overall');
    expect(winnerOverall?.rating).toBeCloseTo(RATING_DEFAULT + 16, 4);
    expect(loserOverall?.rating).toBeCloseTo(RATING_DEFAULT - 16, 4);
    expect(winnerOverall?.wins).toBe(1);
    expect(loserOverall?.losses).toBe(1);
    expect(winnerOverall?.provisional).toBe(true);
    expect(winnerOverall?.deviation).toBeCloseTo(deviationFor(1), 4);

    const events = await handle.db.select().from(ratingEvents).where(eq(ratingEvents.battleId, record.id));
    expect(events).toHaveLength(4);

    const again = await applyBattleToRatings(handle.db, record);
    expect(again).toMatchObject({ applied: false, reason: 'already_applied' });
    expect(await handle.db.select().from(ratings)).toHaveLength(4);
  });

  it('skips demo battles, undecided verdicts and identical competitors', async () => {
    const demo = buildRecord({ visibility: 'public', demo: true, harnessA: superclaude });
    await upsertBattleFromRecord(handle.db, { record: demo });
    expect(await applyBattleToRatings(handle.db, demo)).toMatchObject({ applied: false, reason: 'demo' });

    const undecided = buildRecord({ visibility: 'public', winner: 'inconclusive', harnessA: superclaude });
    await upsertBattleFromRecord(handle.db, { record: undecided });
    expect(await applyBattleToRatings(handle.db, undecided)).toMatchObject({
      applied: false,
      reason: 'no_decision',
    });

    const mirror = buildRecord({ visibility: 'public' });
    await upsertBattleFromRecord(handle.db, { record: mirror });
    expect(await applyBattleToRatings(handle.db, mirror)).toMatchObject({
      applied: false,
      reason: 'same_competitor',
    });

    expect(await handle.db.select().from(ratings)).toHaveLength(0);
  });

  it('refuses to rate a battle whose harnesses were never stored', async () => {
    const record = buildRecord({ harnessA: superclaude });
    expect(await applyBattleToRatings(handle.db, record)).toMatchObject({
      applied: false,
      reason: 'harness_missing',
    });
  });

  it('writes eligible battles into the verified pool only', async () => {
    const record = buildRecord({
      visibility: 'public',
      eligible: true,
      verificationKind: 'cloud',
      harnessA: superclaude,
    });
    await upsertBattleFromRecord(handle.db, { record });
    const applied = await applyBattleToRatings(handle.db, record);
    expect(applied.pool).toBe('verified');

    const community = await getLeaderboard(handle.db, { pool: 'community' });
    const verified = await getLeaderboard(handle.db, { pool: 'verified' });
    expect(community).toHaveLength(0);
    expect(verified).toHaveLength(2);
  });

  it('orders the leaderboard by rating with provisional entries last', async () => {
    const record = buildRecord({ visibility: 'public', harnessA: superclaude, winner: 'a' });
    await upsertBattleFromRecord(handle.db, { record });
    await applyBattleToRatings(handle.db, record);

    const established = await getHarnessBySlug(handle.db, 'vanilla');
    await handle.db
      .update(ratings)
      .set({ battles: RATING_MIN_SAMPLE + 2, provisional: false, rating: 1450 })
      .where(eq(ratings.harnessId, established?.id ?? ''));

    const board = await getLeaderboard(handle.db, { category: 'overall', pool: 'community' });
    expect(board.map((row) => row.harnessSlug)).toEqual(['vanilla', 'acme--superclaude']);
    expect(board[0]?.provisional).toBe(false);
    expect(board[0]?.rating).toBeCloseTo(1450, 4);
    expect(board[1]?.rating).toBeGreaterThan(RATING_DEFAULT);

    const filtered = await getLeaderboard(handle.db, { pool: 'community', agentId: 'codex' });
    expect(filtered).toHaveLength(0);
  });
});
