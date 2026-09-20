import './setup-env';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RATING_MIN_SAMPLE, VERIFIED_REQUIREMENTS } from '@harness-arena/protocol';
import { applyBattleToRatings, getLeaderboard, upsertBattleFromRecord } from '@harness-arena/database';
import LeaderboardPage from '../app/leaderboard/page';
import { withRanks } from '../components/ratings/RatingBits';
import { demoRecord, freshBattleId, makeUser, ratableRecord, testDb } from './helpers';

async function renderLeaderboard(query: {
  category?: string;
  pool?: string;
  agent?: string;
}): Promise<string> {
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
    expect(empty).toContain('no hosted runner exists; this pool is empty');

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
    expect(populated).not.toContain('no hosted runner exists; this pool is empty');
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

describe('leaderboard rank assignment', () => {
  it('numbers ranked rows only, and never hands a provisional row a number', () => {
    const rows = [
      { provisional: false, slug: 'a' },
      { provisional: false, slug: 'b' },
      { provisional: true, slug: 'c' },
      { provisional: false, slug: 'd' },
      { provisional: true, slug: 'e' },
    ];
    const ranked = withRanks(rows);

    expect(ranked.map((row) => row.rank)).toEqual([1, 2, null, 3, null]);
    // the failure this guards: a provisional row in the middle must not consume a rank, so the
    // ranked row after it is #3, not #4
    expect(ranked.find((row) => row.slug === 'd')?.rank).toBe(3);
    // and a table of nothing but provisional rows has no #1 at all
    expect(withRanks([{ provisional: true }, { provisional: true }]).every((row) => row.rank === null)).toBe(
      true,
    );
  });
});

describe('leaderboard page, competitive columns', () => {
  it('shows peak, form, last battle and the sample state for every row', async () => {
    // the two describes above seeded one community battle (agent "fake"), so both competitors hold a
    // provisional community rating with exactly one decided battle
    const dbh = await testDb();
    const rows = await getLeaderboard(dbh, { category: 'overall', pool: 'community' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.provisional)).toBe(true);

    const html = await renderLeaderboard({ pool: 'community' });

    for (const heading of ['Peak', 'Battles', 'W / L / T', 'Form', 'Last battle', 'Sample']) {
      expect(html).toContain(heading);
    }
    // every row here is provisional, so the divider is present and no row carries a rank number
    expect(html).toContain(`Provisional — fewer than ${RATING_MIN_SAMPLE} decided battles, not ranked`);
    expect(html).toContain('provisional');
    expect(html).toContain('ucsandman--agnostic-ai');
    // the constants the numbers came from, stated on the page rather than implied
    expect(html).toContain('Glicko-1 on the battle verdict');
    expect(html).toContain('/docs/ratings');
  });

  it('offers the agents that actually have rows, and ignores one that does not', async () => {
    const all = await renderLeaderboard({ pool: 'community' });
    expect(all).toContain('all agents');
    expect(all).toContain('fake');

    const filtered = await renderLeaderboard({ pool: 'community', agent: 'fake' });
    expect(filtered).toContain('ucsandman--agnostic-ai');

    // an agent with no row in this category is not a filter: the table must not silently empty out
    const bogus = await renderLeaderboard({ pool: 'community', agent: 'no-such-agent' });
    expect(bogus).toContain('ucsandman--agnostic-ai');
    expect(bogus).not.toContain('Nothing rated in Overall yet');
  });

  it('invites a challenge and links the form that creates one', async () => {
    const html = await renderLeaderboard({ pool: 'community' });
    expect(html).toContain('Think your harness is better? Prove it.');
    expect(html).toContain('/challenges/new');
  });

  it('lists every verified requirement, so "empty" reads as a standard and not a gap', async () => {
    const html = await renderLeaderboard({ pool: 'verified' });
    for (const requirement of VERIFIED_REQUIREMENTS) {
      expect(html).toContain(requirement.label);
    }
  });
});
