import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  harnessProfileResponseSchema,
  headToHeadSchema,
  leaderboardResponseSchema,
  makeId,
  ratingHistoryResponseSchema,
  RATING_MIN_SAMPLE,
  type HarnessInsightEntry,
} from '@harness-arena/protocol';
import { applyBattleToRatings, harnesses, upsertBattleFromRecord } from '@harness-arena/database';
import { GET as getLeaderboard } from '@/app/api/v1/leaderboard/route';
import { GET as getProfile } from '@/app/api/v1/harnesses/[slug]/route';
import { GET as getHistory } from '@/app/api/v1/harnesses/[slug]/history/route';
import { GET as getHeadToHead } from '@/app/api/v1/harnesses/[slug]/vs/[other]/route';
import { GET as getInsights } from '@/app/api/v1/harnesses/[slug]/insights/route';
import { freshBattleId, getRequest, jsonOf, makeUser, params, ratableRecord, testDb } from './helpers';

const SLUG = 'ucsandman--agnostic-ai';
const OPPONENT = 'vanilla';

// One rateable battle for the whole file: the integrity checks treat a second battle on the same
// task and commit as a duplicate, so every test below reads this same seeded result instead of
// reseeding (see the identical note in leaderboard.test.ts).
beforeAll(async () => {
  const dbh = await testDb();
  const user = await makeUser('profile-api-owner', 9801);
  const record = ratableRecord({ id: freshBattleId(), demo: false });
  await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
  const applied = await applyBattleToRatings(dbh, record);
  expect(applied.applied).toBe(true);
});

describe('GET /api/v1/leaderboard', () => {
  it('returns valid, provisional community entries and reports the verified pool empty', async () => {
    const community = await getLeaderboard(getRequest('/api/v1/leaderboard?category=overall&pool=community'));
    expect(community.status).toBe(200);
    const communityBody = leaderboardResponseSchema.parse(await jsonOf(community));
    expect(communityBody.minSample).toBe(RATING_MIN_SAMPLE);
    expect(communityBody.poolEmpty).toBe(false);
    expect(communityBody.entries.length).toBeGreaterThan(0);
    for (const entry of communityBody.entries) {
      expect(entry.provisional).toBe(true);
      expect(entry.rank).toBeNull();
    }

    const verified = await getLeaderboard(getRequest('/api/v1/leaderboard?category=overall&pool=verified'));
    const verifiedBody = leaderboardResponseSchema.parse(await jsonOf(verified));
    expect(verifiedBody.poolEmpty).toBe(true);
    expect(verifiedBody.entries).toEqual([]);
  });
});

describe('GET /api/v1/harnesses/:slug', () => {
  it('parses against the profile schema and carries a numeric efficiency sample', async () => {
    const response = await getProfile(getRequest(`/api/v1/harnesses/${SLUG}`), params({ slug: SLUG }));
    expect(response.status).toBe(200);
    const body = harnessProfileResponseSchema.parse(await jsonOf(response));
    expect(body.slug).toBe(SLUG);
    expect(typeof body.efficiencyProfile.tokens.n).toBe('number');
  });

  it('404s an unknown slug', async () => {
    const response = await getProfile(
      getRequest('/api/v1/harnesses/nobody--here'),
      params({ slug: 'nobody--here' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('GET /api/v1/harnesses/:slug/history', () => {
  it('returns a valid points array for a harness with rating events', async () => {
    const response = await getHistory(getRequest(`/api/v1/harnesses/${SLUG}/history`), params({ slug: SLUG }));
    expect(response.status).toBe(200);
    const body = ratingHistoryResponseSchema.parse(await jsonOf(response));
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.points.length).toBeGreaterThan(0);
  });

  it('returns points: [] and still 200 for a catalogued harness with no rating events', async () => {
    const dbh = await testDb();
    const slug = 'history-api--no-events';
    await dbh
      .insert(harnesses)
      .values({ id: makeId('harness'), slug, name: slug, sourceKind: 'local', framework: 'unknown' })
      .onConflictDoNothing({ target: harnesses.slug });

    const response = await getHistory(getRequest(`/api/v1/harnesses/${slug}/history`), params({ slug }));
    expect(response.status).toBe(200);
    const body = ratingHistoryResponseSchema.parse(await jsonOf(response));
    expect(body.points).toEqual([]);
  });
});

describe('GET /api/v1/harnesses/:slug/vs/:other', () => {
  it('returns the real head-to-head record between two harnesses that fought', async () => {
    const response = await getHeadToHead(
      getRequest(`/api/v1/harnesses/${SLUG}/vs/${OPPONENT}`),
      params({ slug: SLUG, other: OPPONENT }),
    );
    expect(response.status).toBe(200);
    const body = headToHeadSchema.parse(await jsonOf(response));
    expect(body.battles).toBeGreaterThanOrEqual(1);
  });

  it('404s an unknown opponent', async () => {
    const response = await getHeadToHead(
      getRequest(`/api/v1/harnesses/${SLUG}/vs/nobody--here`),
      params({ slug: SLUG, other: 'nobody--here' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('GET /api/v1/harnesses/:slug/insights', () => {
  it('returns an insights array', async () => {
    const response = await getInsights(getRequest(`/api/v1/harnesses/${SLUG}/insights`), params({ slug: SLUG }));
    expect(response.status).toBe(200);
    const body = await jsonOf<{ slug: string; insights: HarnessInsightEntry[]; note: string }>(response);
    expect(Array.isArray(body.insights)).toBe(true);
  });
});
