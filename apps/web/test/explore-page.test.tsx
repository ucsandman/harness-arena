import './setup-env';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RATING_MIN_SAMPLE } from '@harness-arena/protocol';
import { applyBattleToRatings, upsertBattleFromRecord } from '@harness-arena/database';
import ExplorePage from '../app/explore/page';
import { EXPLORE_RISING_DAYS } from '@/lib/explore';
import { freshBattleId, makeUser, ratableRecord, testDb } from './helpers';

function render(query: Record<string, string> = {}): Promise<string> {
  return Promise.resolve(ExplorePage({ searchParams: Promise.resolve(query) })).then(
    renderToStaticMarkup,
  );
}

describe('/explore', () => {
  it('gives every section an honest empty state before anything exists', async () => {
    const html = await render();

    expect(html).toContain('Nothing is rated in Overall for this filter yet');
    expect(html).toContain(`No rating moved upward in the last ${EXPLORE_RISING_DAYS} days`);
    expect(html).toContain('Nothing has been rated under this filter yet');
    expect(html).toContain('Nothing open.');
    expect(html).toContain('No pack is published yet');
    expect(html).toContain('No bracket has been built');
    expect(html).toContain('Nothing catalogued');
    expect(html).toContain('Nothing here was executed by Arena');
    expect(html).toContain('0 rated row(s) scanned');
  });

  it('labels a one-battle rating provisional and never numbers it as top', async () => {
    const dbh = await testDb();
    const user = await makeUser('explore-owner', 9861);
    const record = ratableRecord({ id: freshBattleId(), demo: false });
    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    const applied = await applyBattleToRatings(dbh, record);
    expect(applied.applied).toBe(true);

    const html = await render();
    expect(html).toContain('ucsandman--agnostic-ai');
    expect(html).toContain('provisional');
    expect(html).toContain(`Below ${RATING_MIN_SAMPLE} decided battles a rating is provisional`);
    expect(html).toContain('2 rated row(s) scanned');
    // the winner gained rating inside the window, so Rising names it with the events behind the figure
    expect(html).toContain('over 1 rating event(s)');
    expect(html).not.toContain('No rating moved upward');
  });

  it('applies the min-battles filter and reports the volume it scanned', async () => {
    const dbh = await testDb();
    const user = await makeUser('explore-owner-2', 9862);
    const record = ratableRecord({ id: freshBattleId(), demo: false });
    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    await applyBattleToRatings(dbh, record);

    const filtered = await render({ minBattles: String(RATING_MIN_SAMPLE) });
    expect(filtered).toContain('Nothing is rated in Overall for this filter yet');
    // the scan count is the volume behind the verdict, not the filtered result
    expect(filtered).toContain('rated row(s) scanned');
    expect(filtered).not.toContain('over 1 rating event(s)');
  });
});
