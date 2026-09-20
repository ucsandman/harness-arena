import {
  badgeKindSchema,
  RATING_CATEGORY_LABELS,
  RATING_DEFAULT,
  RATING_DEFAULT_DEVIATION,
  ratingCategorySchema,
  type BadgeKind,
  type HarnessProfileResponse,
  type RatingCategory,
} from '@harness-arena/protocol';
import { getLeaderboard, type ArenaDatabase } from '@harness-arena/database';
import { apiError } from '@/lib/api';
import { badgeEtag, renderBadge } from '@/lib/badge';
import { db } from '@/lib/db';
import { buildHarnessProfileResponse } from '@/lib/harness-profile';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string; kind: string }>;
}

const BADGE_LABEL = 'Harness Arena';

/** The agent behind the harness's biggest community `overall` sample, or `'unknown'` when it has none. */
function defaultAgentId(profile: HarnessProfileResponse): string {
  const communityOverall = profile.ratings.filter(
    (row) => row.pool === 'community' && row.category === 'overall',
  );
  if (communityOverall.length === 0) return 'unknown';
  return communityOverall.reduce((best, row) => (row.battles > best.battles ? row : best)).agentId;
}

function ratingValue(
  profile: HarnessProfileResponse,
  pool: 'community' | 'verified',
  agentId: string,
  category: RatingCategory,
  fallback: 'default' | 'no_verified',
): string {
  const row = profile.ratings.find(
    (r) => r.pool === pool && r.agentId === agentId && r.category === category,
  );
  if (!row) {
    if (fallback === 'no_verified') return 'no verified battles';
    return `provisional ${RATING_DEFAULT} ±${RATING_DEFAULT_DEVIATION} · 0 battles`;
  }
  const text = `${Math.round(row.rating)} ±${Math.round(row.deviation)} · ${row.battles} battles`;
  return row.provisional ? `provisional ${text}` : text;
}

function winRateValue(profile: HarnessProfileResponse, agentId: string, category: RatingCategory): string {
  const row = profile.ratings.find(
    (r) => r.pool === 'community' && r.agentId === agentId && r.category === category,
  );
  if (!row || row.battles === 0) return 'no battles';
  const pct = Math.round((row.wins / row.battles) * 100);
  return `${pct}% of ${row.battles} battles`;
}

function correctnessValue(profile: HarnessProfileResponse, category: RatingCategory): string {
  const entry = profile.categoryPerformance.find((c) => c.category === category);
  if (!entry || entry.correctnessRate === null) return 'no correctness data';
  return `${Math.round(entry.correctnessRate * 100)}% correct · n=${entry.correctnessBattles}`;
}

function battlesValue(profile: HarnessProfileResponse, category: RatingCategory): string {
  const entry = profile.categoryPerformance.find((c) => c.category === category);
  return `${entry?.battles ?? 0} battles`;
}

function tokensValue(profile: HarnessProfileResponse): string {
  const { medianRatio, n } = profile.efficiencyProfile.tokens;
  if (medianRatio === null || n === 0) return 'no paired token data';
  const pct = Math.round(Math.abs(medianRatio - 1) * 100);
  if (medianRatio === 1) return `same tokens · n=${n}`;
  return `${pct}% ${medianRatio < 1 ? 'fewer' : 'more'} tokens · n=${n}`;
}

async function topValue(
  dbh: ArenaDatabase,
  profile: HarnessProfileResponse,
  agentId: string,
  category: RatingCategory,
): Promise<string> {
  const rows = await getLeaderboard(dbh, { category, pool: 'community', agentId, limit: 200 });
  const ranked = rows.filter((row) => !row.provisional);
  const index = ranked.findIndex((row) => row.harnessSlug === profile.slug);
  const rank = index === -1 ? null : index + 1;
  if (rank === null || rank > 10) return 'unranked';
  return `Top ${rank} ${RATING_CATEGORY_LABELS[category]}`;
}

async function valueFor(
  dbh: ArenaDatabase,
  kind: BadgeKind,
  profile: HarnessProfileResponse,
  agentId: string,
  category: RatingCategory,
): Promise<string> {
  switch (kind) {
    case 'rating':
      return ratingValue(profile, 'community', agentId, category, 'default');
    case 'verified-rating':
      return ratingValue(profile, 'verified', agentId, category, 'no_verified');
    case 'win-rate':
      return winRateValue(profile, agentId, category);
    case 'correctness':
      return correctnessValue(profile, category);
    case 'battles':
      return battlesValue(profile, category);
    case 'tokens':
      return tokensValue(profile);
    case 'top':
      return topValue(dbh, profile, agentId, category);
  }
}

/** GET /api/v1/badges/:slug/:kind?agent&category — an embeddable SVG, public read, no auth. */
export async function GET(request: Request, ctx: Context): Promise<Response> {
  const { slug, kind: rawKind } = await ctx.params;
  const parsedKind = badgeKindSchema.safeParse(rawKind);
  if (!parsedKind.success) return apiError('invalid_request', `unknown badge kind "${rawKind}"`);
  const kind = parsedKind.data;

  const dbh = await db();
  const profile = await buildHarnessProfileResponse(dbh, slug);
  if (!profile) return apiError('not_found', 'no harness with that slug');

  const searchParams = new URL(request.url).searchParams;
  const category =
    ratingCategorySchema.safeParse(searchParams.get('category') ?? undefined).data ?? 'overall';
  const agentId = searchParams.get('agent') ?? defaultAgentId(profile);

  const value = await valueFor(dbh, kind, profile, agentId, category);
  const svg = renderBadge({ label: BADGE_LABEL, value });

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=3600',
      etag: badgeEtag(value),
    },
  });
}
