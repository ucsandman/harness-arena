import './setup-env';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as AuthModule from '@/lib/auth';
import type { ArenaEvent, ArenaEventOf, Side } from '@harness-arena/protocol';
import { harnesses, upsertBattleFromRecord, type User } from '@harness-arena/database';
import { TestResults } from '../components/battle/TestResults';
import { SAMPLE_EVENTS, SAMPLE_RECORD } from '../lib/sample-battle';
import { demoRecord, freshBattleId, makeUser, testDb } from './helpers';

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
