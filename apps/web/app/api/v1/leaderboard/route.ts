import { RATING_MIN_SAMPLE, leaderboardResponseSchema, ratingCategorySchema, ratingPoolSchema } from '@harness-arena/protocol';
import { getLeaderboard } from '@harness-arena/database';
import { apiJson } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET /api/v1/leaderboard?category&pool&agent&limit — public read, no auth. */
export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const category = ratingCategorySchema.safeParse(searchParams.get('category') ?? undefined).data ?? 'overall';
  const pool = ratingPoolSchema.safeParse(searchParams.get('pool') ?? undefined).data ?? 'community';
  const agentId = searchParams.get('agent');

  const limitParam = Number(searchParams.get('limit') ?? '');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.trunc(limitParam), 200) : 50;

  const dbh = await db();
  const [rows, probe] = await Promise.all([
    getLeaderboard(dbh, { category, pool, agentId: agentId ?? undefined, limit }),
    // a second, unfiltered-by-category probe: the pool can be empty overall even when this category
    // has rows from a different scope, and empty in this category while the pool holds plenty elsewhere
    getLeaderboard(dbh, { category: 'overall', pool, limit: 1 }),
  ]);

  let rank = 0;
  const entries = rows.map((row) => {
    if (!row.provisional) rank += 1;
    return {
      rank: row.provisional ? null : rank,
      harnessSlug: row.harnessSlug,
      harnessName: row.harnessName,
      agentId: row.agentId,
      rating: row.rating,
      deviation: row.deviation,
      peakRating: row.peakRating,
      battles: row.battles,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      provisional: row.provisional,
      form: row.form,
      lastBattleAt: row.lastBattleAt ? row.lastBattleAt.toISOString() : null,
    };
  });

  const response = leaderboardResponseSchema.parse({
    category,
    pool,
    agentId: agentId ?? null,
    minSample: RATING_MIN_SAMPLE,
    entries,
    poolEmpty: probe.length === 0,
  });
  return apiJson(response, 200, { 'cache-control': 'public, max-age=60, s-maxage=300' });
}
