import { ImageResponse } from 'next/og';
import type { ReactElement } from 'react';
import { RATING_DEFAULT, RATING_DEFAULT_DEVIATION } from '@harness-arena/protocol';
import { getHarnessProfile, type HarnessCategoryPerformance } from '@harness-arena/database';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';

export const alt = `${BRAND.name}: harness profile`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// This card is rendered from the database per request. Next caches an opengraph-image route
// by default, which would freeze one battle's numbers into every later share.
export const dynamic = 'force-dynamic';

/**
 * Static hex colours here on purpose: the OG renderer has no CSS variables and no oklch support, so
 * these mirror the dark theme tokens in app/globals.css (same palette as app/opengraph-image.tsx).
 */
const COLOR = {
  bg: '#14171f',
  panel: '#1b1f29',
  border: '#2c313d',
  fg: '#f2f4f8',
  muted: '#9aa3b2',
  sideA: '#5b8df6',
  sideB: '#f0a02c',
};

/** The generic site card, identical to app/opengraph-image.tsx: used whenever a harness cannot be shown. */
function genericCard(): ReactElement {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: COLOR.bg,
        padding: '72px',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
        <svg width="46" height="46" viewBox="0 0 24 24" fill="none" strokeWidth="2.25" strokeLinecap="round">
          <path d="M4 6l5 6-5 6" stroke={COLOR.sideA} />
          <path d="M20 6l-5 6 5 6" stroke={COLOR.sideB} />
          <path d="M12 3.5v17" stroke={COLOR.border} strokeWidth="1.5" />
        </svg>
        <div style={{ color: COLOR.fg, fontSize: 34, fontWeight: 600 }}>{BRAND.name}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
        <div
          style={{
            color: COLOR.fg,
            fontSize: 76,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
          }}
        >
          {BRAND.tagline}
        </div>
        <div style={{ color: COLOR.muted, fontSize: 30, lineHeight: 1.35, maxWidth: 900 }}>
          Battle coding agent setups on the same task and see what actually performs better.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        {[
          { label: 'Side A', color: COLOR.sideA },
          { label: 'Side B', color: COLOR.sideB },
        ].map((side) => (
          <div
            key={side.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              backgroundColor: COLOR.panel,
              border: `1px solid ${COLOR.border}`,
              borderRadius: 999,
              padding: '10px 22px',
              color: side.color,
              fontSize: 24,
            }}
          >
            <div style={{ width: 12, height: 12, borderRadius: 999, backgroundColor: side.color }} />
            {side.label}
          </div>
        ))}
        <div style={{ color: COLOR.muted, fontSize: 24, marginLeft: 'auto', fontFamily: 'monospace' }}>
          {BRAND.cli.npx}
        </div>
      </div>
    </div>
  );
}

function stat(label: string, value: string): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ fontSize: 16, color: COLOR.muted }}>{label}</div>
      <div style={{ fontSize: 26, color: COLOR.fg, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

function categoryRow(entry: HarnessCategoryPerformance): ReactElement {
  return (
    <div
      key={entry.category}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: COLOR.panel,
        border: `1px solid ${COLOR.border}`,
        borderRadius: 10,
        padding: '10px 16px',
      }}
    >
      <div style={{ fontSize: 18, color: COLOR.fg }}>{entry.category}</div>
      <div style={{ fontSize: 18, color: COLOR.muted, fontFamily: 'monospace' }}>
        {`${entry.battles} battles`}
      </div>
    </div>
  );
}

function harnessCard(
  name: string,
  ratingLabel: string,
  totalBattles: number,
  winRateLabel: string,
  topCategories: HarnessCategoryPerformance[],
): ReactElement {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: COLOR.bg,
        padding: '64px',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" strokeWidth="2.25" strokeLinecap="round">
          <path d="M4 6l5 6-5 6" stroke={COLOR.sideA} />
          <path d="M20 6l-5 6 5 6" stroke={COLOR.sideB} />
          <path d="M12 3.5v17" stroke={COLOR.border} strokeWidth="1.5" />
        </svg>
        <div style={{ color: COLOR.muted, fontSize: 22, fontWeight: 600 }}>{BRAND.name}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <div style={{ fontSize: 56, fontWeight: 700, color: COLOR.fg }}>{name}</div>
        <div style={{ display: 'flex', gap: '32px' }}>
          {stat('Community rating', ratingLabel)}
          {stat('Battles', String(totalBattles))}
          {stat('Win rate', winRateLabel)}
        </div>
      </div>

      {topCategories.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {topCategories.map((entry) => categoryRow(entry))}
        </div>
      ) : null}
    </div>
  );
}

export default async function HarnessOpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<ImageResponse> {
  const { slug } = await params;
  const dbh = await db();
  const profile = await getHarnessProfile(dbh, slug);

  if (!profile) {
    return new ImageResponse(genericCard(), size);
  }

  const communityOverall = profile.ratings.filter(
    (row) => row.pool === 'community' && row.category === 'overall',
  );
  const bestRating =
    communityOverall.length > 0
      ? communityOverall.reduce((best, row) => (row.battles > best.battles ? row : best))
      : null;

  const ratingLabel = !bestRating
    ? `provisional ${RATING_DEFAULT} ±${RATING_DEFAULT_DEVIATION}`
    : `${bestRating.provisional ? 'provisional ' : ''}${Math.round(bestRating.rating)} ±${Math.round(bestRating.deviation)}`;
  const totalBattles = bestRating?.battles ?? 0;
  const winRateLabel =
    bestRating && bestRating.battles > 0
      ? `${Math.round((bestRating.wins / bestRating.battles) * 100)}% of ${bestRating.battles}`
      : 'n/a';

  const topCategories = profile.categoryPerformance
    .filter((entry) => entry.category !== 'overall')
    .sort((a, b) => b.battles - a.battles)
    .slice(0, 3);

  return new ImageResponse(
    harnessCard(profile.harness.name, ratingLabel, totalBattles, winRateLabel, topCategories),
    size,
  );
}
