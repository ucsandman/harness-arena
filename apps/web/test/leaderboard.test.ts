import './setup-env';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RATING_MIN_SAMPLE } from '@harness-arena/protocol';
import { applyBattleToRatings, getLeaderboard, upsertBattleFromRecord } from '@harness-arena/database';
import LeaderboardPage from '../app/leaderboard/page';
import { demoRecord, freshBattleId, makeUser, ratableRecord, testDb } from './helpers';

async function renderLeaderboard(query: { category?: string; pool?: string }): Promise<string> {
  return renderToStaticMarkup(await LeaderboardPage({ searchParams: Promise.resolve(query) }));
}

describe('leaderboard data', () => {
  it('returns provisional community rows after one decided battle, and nothing for a demo one', async () => {
    const dbh = await testDb();
    const user = await makeUser('rating-owner', 9601);

    // the exported demo battle, re-identified, marked as a real (non-demo) result and pinned to a
    // harness commit, which the integrity checks require before a battle may move a rating
    const record = ratableRecord({ id: freshBattleId(), demo: false });
    expect(record.verdict?.winner).toBe('a');
    expect(record.spec.category).toBe('debugging');

    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    const applied = await applyBattleToRatings(dbh, record);
    expect(applied.applied).toBe(true);
    expect(applied.pool).toBe('community');
    expect(applied.categories).toEqual(['overall', 'debugging']);

    const overall = await getLeaderboard(dbh, { category: 'overall', pool: 'community' });
    expect(overall).toHaveLength(2);
    for (const row of overall) {
      expect(row.battles).toBe(1);
      expect(row.ties).toBe(0);
      expect(row.wins + row.losses).toBe(1);
      expect(row.provisional).toBe(true);
      expect(row.battles).toBeLessThan(RATING_MIN_SAMPLE);
      expect(row.pool).toBe('community');
      expect(row.agentId).toBe('fake');
    }
    expect(overall.map((row) => row.harnessSlug).sort()).toEqual(['ucsandman--agnostic-ai', 'vanilla']);

    const debugging = await getLeaderboard(dbh, { category: 'debugging', pool: 'community' });
    expect(debugging).toHaveLength(2);

    // the verified pool is separate and stays empty: no cloud battle exists
    const verified = await getLeaderboard(dbh, { category: 'overall', pool: 'verified' });
    expect(verified).toEqual([]);

    // a demo battle never moves a rating
    const demo = demoRecord({ id: freshBattleId() });
    await upsertBattleFromRecord(dbh, { record: demo, visibility: 'public', demo: true });
    const skipped = await applyBattleToRatings(dbh, demo);
    expect(skipped.applied).toBe(false);
    expect(skipped.reason).toBe('demo');

    const unchanged = await getLeaderboard(dbh, { category: 'overall', pool: 'community' });
    expect(unchanged.every((row) => row.battles === 1)).toBe(true);

    // applying the same battle twice is idempotent
    const again = await applyBattleToRatings(dbh, record);
    expect(again.applied).toBe(false);
    expect(again.reason).toBe('already_applied');
  });
});

describe('leaderboard page, verified pool card', () => {
  it('claims the pool is empty only while it is, in every category', async () => {
    const dbh = await testDb();
    const user = await makeUser('verified-owner', 9602);

    // nothing verified yet: the claim and the deliberate-emptiness sentence are both true
    const empty = await renderLeaderboard({ pool: 'verified' });
    expect(empty).toContain('No verified battles exist');
    expect(empty).toContain('deliberately empty');

    // a verification-eligible battle writes rows in the verified pool (poolForRecord)
    const record = ratableRecord({
      id: freshBattleId(),
      demo: false,
      verification: { kind: 'cloud', eligible: true, sandbox: 'arena-cloud-1' },
      // a different task commit from the battle in the test above: same competitors on the same task
      // and the same commit would be the same matchup, which the integrity checks call a duplicate
      repository: { ...demoRecord().repository, commit: 'feedfacefeedfacefeedface' },
    });
    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    const applied = await applyBattleToRatings(dbh, record);
    expect(applied.applied).toBe(true);
    expect(applied.pool).toBe('verified');

    const populated = await renderLeaderboard({ pool: 'verified' });
    expect(populated).not.toContain('No verified battles exist');
    expect(populated).not.toContain('deliberately empty');
    expect(populated).toContain('Verified pool, not Arena-executed');
    expect(populated).toContain('ucsandman--agnostic-ai');

    // the trap: rows are category-scoped, so a category with no verified rows must not restate the
    // global claim. The battle above is 'debugging', so 'refactoring' has no verified row.
    const otherCategory = await renderLeaderboard({ pool: 'verified', category: 'refactoring' });
    expect(otherCategory).not.toContain('No verified battles exist');
    expect(otherCategory).toContain('Nothing rated in Refactoring yet');

    // the community pool card is unaffected
    const community = await renderLeaderboard({ pool: 'community' });
    expect(community).not.toContain('No verified battles exist');
    expect(community).not.toContain('Verified pool, not Arena-executed');
  });
});
