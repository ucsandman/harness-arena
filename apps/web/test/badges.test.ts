import './setup-env';
import { describe, expect, it } from 'vitest';
import { applyBattleToRatings, upsertBattleFromRecord } from '@harness-arena/database';
import { GET as getBadge } from '@/app/api/v1/badges/[slug]/[kind]/route';
import { BADGE_COLORS, badgeEtag, badgeTextWidth, escapeXml, renderBadge } from '@/lib/badge';
import { freshBattleId, getRequest, makeUser, params, ratableRecord, testDb } from './helpers';

/**
 * `renderBadge`/`escapeXml`/`badgeEtag` as pure functions, then the badge route wired to real ratings
 * data. The anti-fabrication check is the point: a harness with one battle must say `provisional`,
 * never a number it does not have the sample for.
 */

describe('renderBadge', () => {
  it('renders a well-formed svg carrying the label and value text', () => {
    const svg = renderBadge({ label: 'Harness Arena', value: '1523 battles' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Harness Arena');
    expect(svg).toContain('1523 battles');
  });

  it('grows the total width with a longer value', () => {
    const widthOf = (svg: string): number => Number(/width="(\d+)"/.exec(svg)?.[1] ?? 0);
    const short = renderBadge({ label: 'x', value: '1' });
    const long = renderBadge({ label: 'x', value: '1234567890 battles' });
    expect(widthOf(long)).toBeGreaterThan(widthOf(short));
  });

  it('escapes & in the value instead of breaking the markup', () => {
    const svg = renderBadge({ label: 'Harness Arena', value: 'A & B' });
    expect(svg).toContain('A &amp; B');
    expect(svg).not.toContain('A & B');
  });
});

describe('escapeXml', () => {
  it('escapes all five XML-significant characters', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});

describe('badgeEtag', () => {
  it('is deterministic for the same value and different for a different one', () => {
    expect(badgeEtag('58% of 24 battles')).toBe(badgeEtag('58% of 24 battles'));
    expect(badgeEtag('58% of 24 battles')).not.toBe(badgeEtag('59% of 24 battles'));
    expect(badgeEtag('x')).toMatch(/^W\/"[0-9a-f]{16}"$/);
  });
});

describe('badgeTextWidth', () => {
  it('grows with text length', () => {
    expect(badgeTextWidth('aaaaaaaaaa')).toBeGreaterThan(badgeTextWidth('a'));
  });
});

describe('BADGE_COLORS', () => {
  it('names a distinct label and value color', () => {
    expect(BADGE_COLORS.label).not.toBe(BADGE_COLORS.value);
  });
});

const SLUG = 'ucsandman--agnostic-ai';

describe('badge route', () => {
  it('never fabricates a number: a lightly-battled harness reads provisional, not a fake rating', async () => {
    const dbh = await testDb();
    const user = await makeUser('badge-owner', 9701);
    const record = ratableRecord({ id: freshBattleId(), demo: false });
    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    await applyBattleToRatings(dbh, record);

    const rating = await getBadge(
      getRequest(`/api/v1/badges/${SLUG}/rating`),
      params({ slug: SLUG, kind: 'rating' }),
    );
    expect(rating.status).toBe(200);
    expect(rating.headers.get('content-type')).toContain('image/svg+xml');
    expect(await rating.text()).toContain('provisional');

    const verified = await getBadge(
      getRequest(`/api/v1/badges/${SLUG}/verified-rating`),
      params({ slug: SLUG, kind: 'verified-rating' }),
    );
    expect(await verified.text()).toContain('no verified battles');

    const top = await getBadge(
      getRequest(`/api/v1/badges/${SLUG}/top?category=overall`),
      params({ slug: SLUG, kind: 'top' }),
    );
    expect(await top.text()).toContain('unranked');
  });

  it('404s an unknown slug', async () => {
    const response = await getBadge(
      getRequest('/api/v1/badges/nobody--here/rating'),
      params({ slug: 'nobody--here', kind: 'rating' }),
    );
    expect(response.status).toBe(404);
  });

  it('400s an unknown badge kind', async () => {
    const response = await getBadge(
      getRequest(`/api/v1/badges/${SLUG}/bogus`),
      params({ slug: SLUG, kind: 'bogus' }),
    );
    expect(response.status).toBe(400);
  });
});
