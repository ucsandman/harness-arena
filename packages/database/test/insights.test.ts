import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ArenaDb } from '../src/client.js';
import { harnessVersions, harnesses } from '../src/schema/index.js';
import { getHarnessInsights } from '../src/insights.js';
import { applyBattleToRatings } from '../src/ratings.js';
import { getHarnessProfile, upsertBattleFromRecord } from '../src/queries.js';
import type { HarnessFixture } from './helpers.js';
import { buildRecord, freshDb } from './helpers.js';

const V1: HarnessFixture = {
  name: 'superclaude',
  source: 'https://github.com/acme/superclaude',
  kind: 'github',
  commit: 'aaa1111',
};
const V2: HarnessFixture = { ...V1, commit: 'bbb2222' };

const SLUG = 'acme--superclaude';

/**
 * Twelve decided public battles: six on version aaa1111 where the harness passes every correctness
 * gate (debugging, all wins) and six on bbb2222 where it fails them (refactoring, all losses), each
 * with half the opponent's tokens.
 */
async function seedHistory(handle: ArenaDb): Promise<void> {
  let day = 1;
  for (const group of [
    { harness: V1, category: 'debugging', winner: 'a' as const, gate: 'a' as const },
    { harness: V2, category: 'refactoring', winner: 'b' as const, gate: 'b' as const },
  ]) {
    for (let i = 0; i < 6; i++) {
      const record = buildRecord({
        visibility: 'public',
        harnessA: group.harness,
        winner: group.winner,
        category: group.category,
        // a distinct repository commit per battle: same matchup, genuinely different work
        repositoryCommit: `${group.gate}${day}${'0'.repeat(8)}`,
        createdAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`,
        tokensA: 500,
        tokensB: 1000,
        breakdown: [
          { factor: 'tests', result: group.gate },
          { factor: 'build', result: 'tie' },
          { factor: 'assertions', result: 'n/a' },
        ],
      });
      const upserted = await upsertBattleFromRecord(handle.db, { record });
      expect(upserted.ratingEligible).toBe(true);
      const applied = await applyBattleToRatings(handle.db, record);
      expect(applied.applied).toBe(true);
      day += 1;
    }
  }

  // pin the version timestamps so "the latest two versions" is not decided by clock resolution
  const [harness] = await handle.db.select().from(harnesses).where(eq(harnesses.slug, SLUG)).limit(1);
  const versions = await handle.db
    .select()
    .from(harnessVersions)
    .where(eq(harnessVersions.harnessId, harness?.id ?? ''));
  for (const version of versions) {
    await handle.db
      .update(harnessVersions)
      .set({
        createdAt: new Date(version.commit === 'aaa1111' ? '2026-09-01T00:00:00Z' : '2026-09-07T00:00:00Z'),
      })
      .where(eq(harnessVersions.id, version.id));
  }
}

describe('harness profile, derived sections', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it('counts every battle towards overall and its own category, with the correctness denominator', async () => {
    await seedHistory(handle);
    const profile = await getHarnessProfile(handle.db, SLUG);
    expect(profile).not.toBeNull();
    expect(profile?.analyzedBattles).toBe(12);

    const overall = profile?.categoryPerformance.find((entry) => entry.category === 'overall');
    expect(overall).toMatchObject({ battles: 12, wins: 6, losses: 6, ties: 0, correctnessBattles: 12 });
    expect(overall?.correctnessRate).toBeCloseTo(0.5, 10);

    const debugging = profile?.categoryPerformance.find((entry) => entry.category === 'debugging');
    expect(debugging).toMatchObject({ battles: 6, wins: 6, losses: 0 });
    expect(debugging?.correctnessRate).toBe(1);
    const refactoring = profile?.categoryPerformance.find((entry) => entry.category === 'refactoring');
    expect(refactoring?.correctnessRate).toBe(0);

    // half the opponent's tokens on every battle; duration and cost have no comparable pair here
    const tokens = profile?.efficiencyProfile.find((entry) => entry.metric === 'tokens_total');
    expect(tokens).toMatchObject({ median: 0.5, n: 12 });
    const duration = profile?.efficiencyProfile.find((entry) => entry.metric === 'duration_ms');
    expect(duration?.n).toBe(12);
    expect(duration?.median).toBeCloseTo(300_000 / 240_000, 10);
    const cost = profile?.efficiencyProfile.find((entry) => entry.metric === 'cost_usd');
    expect(cost).toMatchObject({ median: null, n: 0 });

    const versions = profile?.versions ?? [];
    expect(versions.map((version) => version.commit)).toEqual(['bbb2222', 'aaa1111']);
    expect(versions[0]).toMatchObject({ battles: 6, wins: 0, losses: 6, ties: 0 });
    expect(versions[1]).toMatchObject({ battles: 6, wins: 6, losses: 0, ties: 0 });
    expect(profile?.ratings.every((row) => row.form.length > 0)).toBe(true);
  });
});

describe('getHarnessInsights', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it('says nothing about a harness nobody has tested', async () => {
    expect(await getHarnessInsights(handle.db, 'nope')).toEqual({ insights: [] });

    const record = buildRecord({
      visibility: 'public',
      harnessA: V1,
      winner: 'a',
      category: 'debugging',
      breakdown: [{ factor: 'tests', result: 'a' }],
    });
    await upsertBattleFromRecord(handle.db, { record });
    await applyBattleToRatings(handle.db, record);
    // one battle clears no threshold: no category insight, no version delta, no efficiency claim
    expect(await getHarnessInsights(handle.db, SLUG)).toEqual({ insights: [] });
  });

  it('derives category, version and efficiency sentences that each name their sample', async () => {
    await seedHistory(handle);
    const { insights } = await getHarnessInsights(handle.db, SLUG);
    const kinds = insights.map((insight) => insight.kind);
    expect(kinds).toContain('category_strength');
    expect(kinds).toContain('category_weakness');
    expect(kinds).toContain('version_delta');
    expect(kinds).toContain('efficiency');

    for (const insight of insights) {
      expect(insight.text).toMatch(/\(\d+ comparable battles\)$/);
      expect(insight.text).toContain(`(${insight.support.n} comparable battles)`);
      expect(insight.support.n).toBeGreaterThanOrEqual(5);
    }

    const strength = insights.find((insight) => insight.kind === 'category_strength');
    expect(strength?.support).toMatchObject({ category: 'debugging', n: 6, deltaPoints: 50 });
    expect(strength?.text).toContain('Debugging');
    expect(strength?.text).toContain('100%');
    expect(strength?.text).toContain('+50 points');

    const weakness = insights.find((insight) => insight.kind === 'category_weakness');
    expect(weakness?.support).toMatchObject({ category: 'refactoring', deltaPoints: -50 });

    const version = insights.find((insight) => insight.kind === 'version_delta');
    expect(version?.support).toMatchObject({ n: 12, deltaPoints: -100 });
    expect(version?.text).toContain('bbb2222');
    expect(version?.text).toContain('aaa1111');

    const efficiency = insights.find((insight) => insight.kind === 'efficiency');
    expect(efficiency?.support).toMatchObject({ n: 12, ratio: 0.5 });
    expect(efficiency?.text).toContain('50% fewer tokens');
  });

  it('is deterministic: the same database yields the same sentences', async () => {
    await seedHistory(handle);
    const first = await getHarnessInsights(handle.db, SLUG);
    const second = await getHarnessInsights(handle.db, SLUG);
    expect(second).toEqual(first);
  });
});
