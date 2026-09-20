import './setup-env';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as AuthModule from '@/lib/auth';
import type { ArenaEvent, ArenaEventOf, Side } from '@harness-arena/protocol';
import {
  applyBattleToRatings,
  getLeaderboard,
  harnesses,
  upsertBattleFromRecord,
  type User,
} from '@harness-arena/database';
import { TestResults } from '../components/battle/TestResults';
import { SAMPLE_EVENTS, SAMPLE_RECORD } from '../lib/sample-battle';
import { demoRecord, freshBattleId, makeUser, ratableRecord, testDb } from './helpers';

/** The dashboard is behind requireUser; the session cookie needs a request, so the user is injected. */
let currentUser: User | null = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return {
    ...actual,
    requireUser: async () => {
      if (!currentUser) throw new Error('the test did not set a user');
      return currentUser;
    },
  };
});

const { default: DashboardPage } = await import('../app/dashboard/page');

const battleBaseline = SAMPLE_EVENTS.find(
  (event): event is ArenaEventOf<'test.completed'> =>
    event.type === 'test.completed' && event.payload.phase === 'baseline',
);

/** The engine's own shape: a baseline test.completed carries the side whose workspace it ran in. */
function sideBaseline(side: Side, passed: number, failed: number): ArenaEvent {
  if (!battleBaseline) throw new Error('the sample battle has no baseline test.completed event');
  return {
    ...battleBaseline,
    id: `${battleBaseline.id}-${side}`,
    side,
    runId: SAMPLE_RECORD.runs[side].id,
    payload: { ...battleBaseline.payload, passed, failed, total: passed + failed },
  };
}

describe('tests tab baseline', () => {
  it('reads each side its own baseline instead of claiming none was recorded', () => {
    const events = [sideBaseline('a', 41, 17), sideBaseline('b', 22, 13)];
    const html = renderToStaticMarkup(<TestResults record={SAMPLE_RECORD} events={events} />);

    expect(html).not.toContain('No baseline run was recorded');
    const split = html.indexOf(SAMPLE_RECORD.runs.b.label);
    expect(split).toBeGreaterThan(0);
    const [sideA, sideB] = [html.slice(0, split), html.slice(split)];
    expect(sideA).toContain('>41</span>');
    expect(sideA).toContain('>17</span>');
    expect(sideA).not.toContain('>22</span>');
    expect(sideB).toContain('>22</span>');
    expect(sideB).toContain('>13</span>');
    expect(sideB).not.toContain('>41</span>');
  });

  it('still shows a battle-level baseline (side null) on both sides', () => {
    const html = renderToStaticMarkup(<TestResults record={SAMPLE_RECORD} events={[...SAMPLE_EVENTS]} />);
    expect(html).not.toContain('No baseline run was recorded');
    // the sample's shared baseline: 39 passed, 3 failed, in both side cards
    expect(html.split('Baseline (before this run)')).toHaveLength(3);
    const split = html.indexOf(SAMPLE_RECORD.runs.b.label);
    expect(html.slice(0, split)).toContain('>39</span>');
    expect(html.slice(split)).toContain('>39</span>');
  });

  it('says so per side when that side has no baseline', () => {
    const html = renderToStaticMarkup(
      <TestResults record={SAMPLE_RECORD} events={[sideBaseline('a', 41, 17)]} />,
    );
    const split = html.indexOf(SAMPLE_RECORD.runs.b.label);
    expect(html.slice(0, split)).not.toContain('No baseline run was recorded');
    expect(html.slice(split)).toContain('No baseline run was recorded for this side');
  });
});

describe('dashboard stats', () => {
  it('reports a page-bounded count as a floor, never as a total', async () => {
    const dbh = await testDb();
    currentUser = await makeUser('dashboard-owner', 9701);

    // 21 uploads: one more than the dashboard lists
    for (let i = 0; i < 21; i += 1) {
      const record = demoRecord({ id: freshBattleId(), demo: false });
      await upsertBattleFromRecord(dbh, { record, ownerUserId: currentUser.id, visibility: 'private' });
    }
    // a full catalog page with one row of mine: the owner filter runs in the database, so the count is exact
    await dbh.insert(harnesses).values(
      Array.from({ length: 200 }, (_, i) => ({
        id: `hrn_fill${String(i).padStart(12, '0')}`,
        slug: `fill-${String(i).padStart(3, '0')}`,
        name: `filler ${i}`,
        sourceKind: 'local' as const,
        ownerUserId: i === 0 ? currentUser!.id : null,
      })),
    );

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain('>20+</span>');
    expect(html).toContain('newest 20 listed below');
    expect(html).toContain('>1</span>');
    expect(html).not.toContain('found in your newest 200 harnesses');
    expect(html).not.toContain('Only your newest 200 harnesses are searched');
  });
});

/**
 * The harness profile is the page a maintainer links from a README, so its failure mode is a number
 * with no sample behind it. These tests pin the honest-empty states first (no rating, no efficiency
 * data, an empty verified pool) and only then the populated ones, and check that a demo battle never
 * turns into a rating.
 */
const { default: HarnessProfilePage } = await import('../app/harnesses/[slug]/page');

const PROFILE_SLUG = 'ucsandman--agnostic-ai';

async function renderProfile(slug: string): Promise<string> {
  return renderToStaticMarkup(
    await HarnessProfilePage({
      params: Promise.resolve({ slug }),
      searchParams: Promise.resolve({}),
    }),
  );
}

describe('harness profile, before anything is rated', () => {
  it('says it has no rating rather than printing a default one', async () => {
    const dbh = await testDb();
    // the dashboard test above uploaded private battles for this harness, so the catalogue row exists
    // with no public decided battle behind it: the profile must not invent a 1500
    const rows = await getLeaderboard(dbh, { category: 'overall', pool: 'community' });
    expect(rows.some((row) => row.harnessSlug === PROFILE_SLUG)).toBe(false);

    const html = await renderProfile(PROFILE_SLUG);
    expect(html).toContain('No decided battles yet, so this harness has no community rating');
    // a rating row renders a "<agent> · overall" stat; with nothing rated there must be none, so the
    // page cannot be showing the 1500 default as though it were earned
    expect(html).not.toContain('· overall');
  });

  it('states the verified pool is empty for this harness, and why', async () => {
    const html = await renderProfile(PROFILE_SLUG);
    expect(html).toContain('no hosted runner exists, so this pool is empty for every');
    expect(html).toContain('Community results never feed it');
  });

  it('prints n/a with the battle count instead of a zero efficiency ratio', async () => {
    const html = await renderProfile(PROFILE_SLUG);
    expect(html).toContain('n/a (0 battles)');
    expect(html).toContain('Efficiency against its opponents');
  });

  it('offers a challenge and README badges that point at real routes', async () => {
    const html = await renderProfile(PROFILE_SLUG);
    expect(html).toContain('Challenge this harness');
    expect(html).toContain(`/challenges/new?b=${PROFILE_SLUG}`);
    expect(html).toContain('README badges');
    // the snippet a maintainer pastes must be a working absolute URL, with no double slash
    expect(html).toContain('http://localhost:3000/api/v1/badges/');
    expect(html).not.toContain('localhost:3000//');
    expect(html).toContain(`/api/v1/badges/${PROFILE_SLUG}/rating`);
    expect(html).toContain(`/api/v1/badges/${PROFILE_SLUG}/verified-rating`);
  });
});

describe('harness profile, once a battle is rated', () => {
  it('shows the rating, its sample, the category record and the history it came from', async () => {
    const dbh = await testDb();
    const user = await makeUser('profile-owner', 9702);
    const record = ratableRecord({ id: freshBattleId(), demo: false });
    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    const applied = await applyBattleToRatings(dbh, record);
    expect(applied.applied).toBe(true);

    const html = await renderProfile(PROFILE_SLUG);
    // one decided battle is under the minimum sample, so the page must label it, not rank it
    expect(html).toContain('provisional');
    expect(html).toContain('Category performance');
    expect(html).toContain('Debugging');
    expect(html).toContain('Rating history');
    expect(html).toContain(`/battles/${record.id}`);
    expect(html).toContain('Head-to-head');
    expect(html).toContain('/harnesses/ucsandman--agnostic-ai/vs/vanilla');
    expect(html).toContain('Versions tested');
  });

  it('never lets a demo battle move the rating it displays', async () => {
    const dbh = await testDb();
    const before = await getLeaderboard(dbh, { category: 'overall', pool: 'community' });
    const mine = before.find((row) => row.harnessSlug === PROFILE_SLUG);
    expect(mine?.battles).toBe(1);

    const demo = demoRecord({ id: freshBattleId() });
    await upsertBattleFromRecord(dbh, { record: demo, visibility: 'public', demo: true });
    const skipped = await applyBattleToRatings(dbh, demo);
    expect(skipped.applied).toBe(false);
    expect(skipped.reason).toBe('demo');

    const after = await getLeaderboard(dbh, { category: 'overall', pool: 'community' });
    expect(after.find((row) => row.harnessSlug === PROFILE_SLUG)?.battles).toBe(1);

    // and the page shows the demo battle as demo data, never as a result behind the rating
    const html = await renderProfile(PROFILE_SLUG);
    expect(html).toContain('Demo data');
  });
});
