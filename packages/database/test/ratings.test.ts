import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  RATING_DEFAULT,
  RATING_DEFAULT_DEVIATION,
  RATING_FORM_WINDOW,
  RATING_MAX_RANKED_DEVIATION,
  RATING_MIN_SAMPLE,
} from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import { battleRuns, ratingEvents, ratings } from '../src/schema/index.js';
import {
  applyBattleToRatings,
  expectedScore,
  gFactor,
  getLeaderboard,
  getRating,
  getRatingHistory,
  inflateDeviation,
  initialRatingState,
  isProvisional,
  mapCategory,
  poolForRecord,
  ratingCategoriesFor,
  updateRating,
} from '../src/ratings.js';
import { getHarnessBySlug, upsertBattleFromRecord } from '../src/queries.js';
import type { HarnessFixture } from './helpers.js';
import { buildRecord, freshDb } from './helpers.js';

const superclaude: HarnessFixture = {
  name: 'superclaude',
  source: 'https://github.com/acme/superclaude',
  kind: 'github',
  commit: 'abc1234',
};

const unpinned: HarnessFixture = {
  name: 'driftharness',
  source: 'https://github.com/acme/driftharness',
  kind: 'github',
  commit: null,
};

/** A record that passes every integrity check: pinned github harness vs vanilla, decided, completed. */
function ratableRecord(overrides: Parameters<typeof buildRecord>[0] = {}) {
  return buildRecord({ visibility: 'public', harnessA: superclaude, winner: 'a', ...overrides });
}

describe('Glicko-1 rating math', () => {
  it('expected score is symmetric, 0.5 for equal ratings, and softened by an uncertain opponent', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1600, 1400) + expectedScore(1400, 1600)).toBeCloseTo(1, 10);
    expect(expectedScore(1800, 1500)).toBeGreaterThan(0.5);

    // g(RD) < 1 pulls the expectation towards a coin flip when the opponent is barely known
    expect(gFactor(0)).toBeCloseTo(1, 10);
    expect(gFactor(RATING_DEFAULT_DEVIATION)).toBeLessThan(1);
    expect(expectedScore(1800, 1500, 350)).toBeLessThan(expectedScore(1800, 1500, 0));
    expect(expectedScore(1800, 1500, 350)).toBeGreaterThan(0.5);
  });

  it('takes the textbook Glicko step from a fresh rating', () => {
    const state = initialRatingState();
    const opponent = { rating: RATING_DEFAULT, deviation: RATING_DEFAULT_DEVIATION };
    const won = updateRating(state, opponent, 'win');
    const lost = updateRating(state, opponent, 'loss');
    const tied = updateRating(state, opponent, 'tie');

    expect(won.rating).toBeCloseTo(1662.212, 3);
    expect(lost.rating).toBeCloseTo(1337.788, 3);
    expect(tied.rating).toBeCloseTo(1500, 6);
    // the deviation shrinks from the 350 it starts at, and the same amount whatever the outcome
    expect(won.deviation).toBeCloseTo(290.231, 3);
    expect(lost.deviation).toBeCloseTo(290.231, 3);
    expect(won.wins).toBe(1);
    expect(lost.losses).toBe(1);
    expect(tied.ties).toBe(1);
    expect(won.battles).toBe(1);
  });

  it('moves a settled rating far less than a fresh one', () => {
    const settled = { ...initialRatingState(), deviation: 60, battles: 40 };
    const next = updateRating(settled, { rating: RATING_DEFAULT, deviation: 60 }, 'win');
    expect(next.rating).toBeCloseTo(1509.894, 3);
    expect(next.deviation).toBeCloseTo(59.155, 3);
    expect(next.deviation).toBeLessThan(settled.deviation);
  });

  it('inflates the deviation for idle time, up to the default and no further', () => {
    expect(inflateDeviation(60, 0)).toBe(60);
    expect(inflateDeviation(60, 30)).toBeCloseTo(153.523, 3);
    expect(inflateDeviation(60, 180)).toBe(RATING_DEFAULT_DEVIATION);
    expect(inflateDeviation(60, -5)).toBe(60);

    // a rating that sat idle for a month moves further on its next battle than one that did not
    const base = { ...initialRatingState(), deviation: 60, battles: 40, rating: 1600 };
    const now = new Date('2026-09-19T00:00:00.000Z');
    const idle = { ...base, lastBattleAt: new Date('2026-08-20T00:00:00.000Z') };
    const active = { ...base, lastBattleAt: new Date('2026-09-18T00:00:00.000Z') };
    const opponent = { rating: 1600, deviation: 60 };
    const idleNext = updateRating(idle, opponent, 'win', now);
    const activeNext = updateRating(active, opponent, 'win', now);
    expect(idleNext.rating - 1600).toBeGreaterThan(activeNext.rating - 1600);
    expect(idleNext.lastBattleAt).toEqual(now);
  });

  it('is provisional below the sample floor or above the deviation ceiling', () => {
    expect(isProvisional(0, 30)).toBe(true);
    expect(isProvisional(RATING_MIN_SAMPLE - 1, 30)).toBe(true);
    expect(isProvisional(RATING_MIN_SAMPLE, 30)).toBe(false);
    expect(isProvisional(RATING_MIN_SAMPLE, RATING_MAX_RANKED_DEVIATION + 1)).toBe(true);
    expect(isProvisional(500, RATING_MAX_RANKED_DEVIATION)).toBe(false);
    expect(updateRating(initialRatingState(), { rating: 1500, deviation: 350 }, 'win').provisional).toBe(
      true,
    );
  });

  it('tracks the peak rating and a form string capped at the window', () => {
    const opponent = { rating: RATING_DEFAULT, deviation: 60 };
    let state = initialRatingState();
    const outcomes = [
      'win',
      'win',
      'loss',
      'tie',
      'win',
      'loss',
      'loss',
      'win',
      'tie',
      'win',
      'loss',
      'win',
    ] as const;
    let peakSeen = RATING_DEFAULT;
    for (const outcome of outcomes) {
      state = updateRating(state, opponent, outcome);
      peakSeen = Math.max(peakSeen, state.rating);
    }
    expect(state.battles).toBe(12);
    expect(state.form).toHaveLength(RATING_FORM_WINDOW);
    // oldest first, the first two of the twelve outcomes dropped off the window
    expect(state.form).toBe('LTWLLWTWLW');
    expect(state.form.endsWith('W')).toBe(true);
    expect(state.peakRating).toBeCloseTo(peakSeen, 10);
    expect(state.peakRating).toBeGreaterThanOrEqual(state.rating);
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
    const record = ratableRecord({ category: 'debugging' });
    const upserted = await upsertBattleFromRecord(handle.db, { record });
    expect(upserted.ratingEligible).toBe(true);

    const now = new Date('2026-09-20T12:00:00.000Z');
    const applied = await applyBattleToRatings(handle.db, record, { now });
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
    expect(winnerOverall?.rating).toBeCloseTo(1662.212, 3);
    expect(loserOverall?.rating).toBeCloseTo(1337.788, 3);
    expect(winnerOverall?.deviation).toBeCloseTo(290.231, 3);
    expect(winnerOverall?.wins).toBe(1);
    expect(loserOverall?.losses).toBe(1);
    expect(winnerOverall?.provisional).toBe(true);
    expect(winnerOverall?.peakRating).toBeCloseTo(1662.212, 3);
    expect(loserOverall?.peakRating).toBe(RATING_DEFAULT);
    expect(winnerOverall?.form).toBe('W');
    expect(loserOverall?.form).toBe('L');
    expect(winnerOverall?.lastBattleAt?.toISOString()).toBe(now.toISOString());

    const events = await handle.db.select().from(ratingEvents).where(eq(ratingEvents.battleId, record.id));
    expect(events).toHaveLength(4);
    const runs = await handle.db.select().from(battleRuns).where(eq(battleRuns.battleId, record.id));
    const runA = runs.find((row) => row.side === 'a');
    const winnerEvent = events.find(
      (row) => row.harnessId === winnerHarness?.id && row.category === 'overall',
    );
    // every event is auditable on its own: version, opponent, opponent rating, both deviations
    expect(winnerEvent?.harnessVersionId).toBe(runA?.harnessVersionId);
    expect(winnerEvent?.harnessVersionId).toBeTruthy();
    expect(winnerEvent?.opponentHarnessId).toBe(loserHarness?.id);
    expect(winnerEvent?.opponentRating).toBe(RATING_DEFAULT);
    expect(winnerEvent?.outcome).toBe('win');
    expect(winnerEvent?.ratingBefore).toBe(RATING_DEFAULT);
    expect(winnerEvent?.ratingAfter).toBeCloseTo(1662.212, 3);
    expect(winnerEvent?.deviationBefore).toBe(RATING_DEFAULT_DEVIATION);
    expect(winnerEvent?.deviationAfter).toBeCloseTo(290.231, 3);

    const again = await applyBattleToRatings(handle.db, record);
    expect(again).toMatchObject({ applied: false, reason: 'already_applied' });
    expect(await handle.db.select().from(ratings)).toHaveLength(4);
    expect(await handle.db.select().from(ratingEvents)).toHaveLength(4);
  });

  it('skips demo battles, undecided verdicts and identical competitors', async () => {
    const demo = ratableRecord({ demo: true });
    await upsertBattleFromRecord(handle.db, { record: demo });
    expect(await applyBattleToRatings(handle.db, demo)).toMatchObject({ applied: false, reason: 'demo' });

    const undecided = ratableRecord({ winner: 'inconclusive' });
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
    const record = ratableRecord();
    expect(await applyBattleToRatings(handle.db, record)).toMatchObject({
      applied: false,
      reason: 'harness_missing',
    });
  });

  it('refuses a battle the integrity checks blocked, and says integrity', async () => {
    // a github harness with no resolved commit: the result cannot be attributed to a version
    const record = ratableRecord({ harnessA: unpinned });
    const upserted = await upsertBattleFromRecord(handle.db, { record });
    expect(upserted.ratingEligible).toBe(false);
    expect(upserted.integrity.flags.map((flag) => flag.code)).toContain('harness_commit_missing');

    expect(await applyBattleToRatings(handle.db, record)).toMatchObject({
      applied: false,
      reason: 'integrity',
    });
    expect(await handle.db.select().from(ratings)).toHaveLength(0);
  });

  it('rates the first of two identical battles and refuses the copy', async () => {
    const first = ratableRecord();
    await upsertBattleFromRecord(handle.db, { record: first });
    expect((await applyBattleToRatings(handle.db, first)).applied).toBe(true);

    // same task, same commit, same competitors, same evaluation: a re-upload under a new id
    const copy = ratableRecord();
    expect(copy.id).not.toBe(first.id);
    const upserted = await upsertBattleFromRecord(handle.db, { record: copy });
    expect(upserted.integrity.fingerprint).toBe(
      (await upsertBattleFromRecord(handle.db, { record: first })).integrity.fingerprint,
    );
    const duplicateFlag = upserted.integrity.flags.find((flag) => flag.code === 'duplicate_battle');
    expect(duplicateFlag?.detail).toContain(first.id);
    expect(upserted.ratingEligible).toBe(false);
    expect(await applyBattleToRatings(handle.db, copy)).toMatchObject({
      applied: false,
      reason: 'integrity',
    });

    const rows = await handle.db.select().from(ratings);
    expect(rows.every((row) => row.battles === 1)).toBe(true);
  });

  it('writes eligible battles into the verified pool only, never mixing the two', async () => {
    const record = ratableRecord({ eligible: true, verificationKind: 'cloud' });
    await upsertBattleFromRecord(handle.db, { record });
    const applied = await applyBattleToRatings(handle.db, record);
    expect(applied.pool).toBe('verified');

    const community = await getLeaderboard(handle.db, { pool: 'community' });
    const verified = await getLeaderboard(handle.db, { pool: 'verified' });
    expect(community).toHaveLength(0);
    expect(verified).toHaveLength(2);
    expect(verified.every((row) => row.pool === 'verified')).toBe(true);
  });

  it('orders the leaderboard by rating with provisional entries last', async () => {
    const record = ratableRecord();
    await upsertBattleFromRecord(handle.db, { record });
    await applyBattleToRatings(handle.db, record);

    const established = await getHarnessBySlug(handle.db, 'vanilla');
    await handle.db
      .update(ratings)
      .set({ battles: RATING_MIN_SAMPLE + 2, provisional: false, rating: 1450, deviation: 45, form: 'WWLWW' })
      .where(eq(ratings.harnessId, established?.id ?? ''));

    const board = await getLeaderboard(handle.db, { category: 'overall', pool: 'community' });
    expect(board.map((row) => row.harnessSlug)).toEqual(['vanilla', 'acme--superclaude']);
    expect(board[0]?.provisional).toBe(false);
    expect(board[0]?.rating).toBeCloseTo(1450, 4);
    expect(board[0]?.form).toBe('WWLWW');
    expect(board[1]?.rating).toBeGreaterThan(RATING_DEFAULT);
    expect(board[1]?.peakRating).toBeGreaterThan(RATING_DEFAULT);
    expect(board[1]?.lastBattleAt).toBeInstanceOf(Date);

    const filtered = await getLeaderboard(handle.db, { pool: 'community', agentId: 'codex' });
    expect(filtered).toHaveLength(0);
  });

  it('serves one rating and the history behind it, oldest point first', async () => {
    const first = ratableRecord({ createdAt: '2026-09-01T10:00:00.000Z' });
    await upsertBattleFromRecord(handle.db, { record: first });
    await applyBattleToRatings(handle.db, first, { now: new Date('2026-09-01T10:00:00.000Z') });

    // a second, genuinely different battle: another repository commit, so not a duplicate
    const second = ratableRecord({ winner: 'b', repositoryCommit: 'b2c3d4e5f6a7' });
    await upsertBattleFromRecord(handle.db, { record: second });
    const applied = await applyBattleToRatings(handle.db, second, {
      now: new Date('2026-09-05T10:00:00.000Z'),
    });
    expect(applied.applied).toBe(true);

    const rating = await getRating(handle.db, 'acme--superclaude', { agentId: 'claude-code' });
    expect(rating?.battles).toBe(2);
    expect(rating?.wins).toBe(1);
    expect(rating?.losses).toBe(1);
    expect(rating?.form).toBe('WL');
    expect(await getRating(handle.db, 'acme--superclaude', { agentId: 'codex' })).toBeNull();
    expect(await getRating(handle.db, 'nope', { agentId: 'claude-code' })).toBeNull();

    const history = await getRatingHistory(handle.db, 'acme--superclaude', { agentId: 'claude-code' });
    expect(history).toHaveLength(2);
    expect(history.map((point) => point.outcome)).toEqual(['win', 'loss']);
    expect(history[0]?.battleId).toBe(first.id);
    expect(history[0]?.delta).toBeGreaterThan(0);
    expect(history[1]?.delta).toBeLessThan(0);
    expect(history[0]?.opponentSlug).toBe('vanilla');
    expect(history[0]?.harnessCommit).toBe('abc1234');
    expect(history[0]?.rating).toBeCloseTo(1662.212, 3);
    expect(new Date(history[0]?.at as string).getTime()).toBeLessThan(
      new Date(history[1]?.at as string).getTime(),
    );

    expect(await getRatingHistory(handle.db, 'acme--superclaude', { pool: 'verified' })).toEqual([]);
    expect(await getRatingHistory(handle.db, 'nope')).toEqual([]);
  });
});
