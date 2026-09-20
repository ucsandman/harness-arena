import { ratingCategorySchema, ratingHistoryResponseSchema, ratingPoolSchema } from '@harness-arena/protocol';
import { getHarnessBySlug, getRatingHistory } from '@harness-arena/database';
import { apiError, apiJson } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string }>;
}

/** GET /api/v1/harnesses/:slug/history?agent&category&pool — the rating curve, public read, no auth. */
export async function GET(request: Request, ctx: Context): Promise<Response> {
  const { slug } = await ctx.params;

  const dbh = await db();
  const harness = await getHarnessBySlug(dbh, slug);
  if (!harness) return apiError('not_found', 'no harness with that slug');

  const searchParams = new URL(request.url).searchParams;
  const category = ratingCategorySchema.safeParse(searchParams.get('category') ?? undefined).data ?? 'overall';
  const pool = ratingPoolSchema.safeParse(searchParams.get('pool') ?? undefined).data ?? 'community';
  const agentId = searchParams.get('agent');

  // a harness with no rating events at all is a real answer (points: []), not a 404
  const points = await getRatingHistory(dbh, slug, { category, pool, ...(agentId ? { agentId } : {}) });

  const response = ratingHistoryResponseSchema.parse({ slug, agentId, category, pool, points });
  return apiJson(response, 200, { 'cache-control': 'public, max-age=60, s-maxage=300' });
}
