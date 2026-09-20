import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyBattleToRatings, getHeadToHead, upsertBattleFromRecord } from '@harness-arena/database';
import HeadToHeadPage from '../app/harnesses/[slug]/vs/[other]/page';
import { freshBattleId, makeUser, ratableRecord, testDb } from './helpers';

/**
 * The head-to-head page is a counting surface: every figure on it comes from the set of real public
 * battles the filters select. These tests pin that the rendered numbers equal what the query returns,
 * that an unknown opponent 404s rather than rendering an empty record, and that the "run this matchup"
 * block hands over a command the CLI actually accepts.
 */

const SUBJECT = 'ucsandman--agnostic-ai';
const OPPONENT = 'vanilla';

async function render(
  params: { slug: string; other: string },
  searchParams: Record<string, string> = {},
): Promise<string> {
  return renderToStaticMarkup(
    await HeadToHeadPage({
      params: Promise.resolve(params),
      searchParams: Promise.resolve(searchParams),
    }),
  );
}

beforeAll(async () => {
  const dbh = await testDb();
  const user = await makeUser('h2h-owner', 9801);
  const record = ratableRecord({ id: freshBattleId(), demo: false });
  await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
  const applied = await applyBattleToRatings(dbh, record);
  expect(applied.applied).toBe(true);
});

describe('head-to-head page', () => {
  it('renders the record the query actually counted, not a rounded story', async () => {
    const dbh = await testDb();
    const record = await getHeadToHead(dbh, SUBJECT, OPPONENT, {});
    expect(record).not.toBeNull();
    expect(record?.battles).toBe(1);
    expect(record?.wins).toBe(1);

    const html = await render({ slug: SUBJECT, other: OPPONENT });
    expect(html).toContain('Record');
    // W / L / T exactly as the query returned it
    expect(html).toContain(`${record?.wins} / ${record?.losses} / ${record?.ties}`);
    expect(html).toContain('Win rate');
    // the denominator travels with the rate
    expect(html).toContain(`of ${record?.battles} decided`);
    expect(html).toContain('Inconclusive');
  });

  it('offers every filter as a link and can clear them all', async () => {
    const html = await render({ slug: SUBJECT, other: OPPONENT });
    for (const label of ['Agent', 'Category', 'Pool', 'Since']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('clear all');
    expect(html).toContain('category=debugging');
    expect(html).toContain('pool=community');
    expect(html).toContain('agent=fake');
  });

  it('narrows to a category with no battles and says so instead of showing the unfiltered record', async () => {
    const html = await render({ slug: SUBJECT, other: OPPONENT }, { category: 'frontend' });
    expect(html).toContain('have not met under the current filters');
  });

  it('lists the battles the counts are made of', async () => {
    const html = await render({ slug: SUBJECT, other: OPPONENT });
    expect(html).toContain('Battles behind these numbers');
    expect(html).toContain('/battles/');
  });

  it('shows a real arena command, never a button that runs nothing', async () => {
    const html = await render({ slug: SUBJECT, other: OPPONENT });
    expect(html).toContain('Run this matchup');
    expect(html).toContain('arena challenge create');
    expect(html).toContain('--a ');
    expect(html).toContain('--b ');
    expect(html).toContain('--agent ');
    // Arena hosts no runner, and the page says so rather than implying a hosted run
    expect(html).toContain('runs on your machine');
  });

  it('404s on an opponent that is not in the catalogue', async () => {
    await expect(render({ slug: SUBJECT, other: 'not-a-real-harness' })).rejects.toThrow();
  });
});
