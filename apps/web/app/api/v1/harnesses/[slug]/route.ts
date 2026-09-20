import { apiError, apiJson } from '@/lib/api';
import { db } from '@/lib/db';
import { buildHarnessProfileResponse } from '@/lib/harness-profile';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string }>;
}

/** GET /api/v1/harnesses/:slug — the profile page's data, public read, no auth. */
export async function GET(_request: Request, ctx: Context): Promise<Response> {
  const { slug } = await ctx.params;

  const dbh = await db();
  const profile = await buildHarnessProfileResponse(dbh, slug);
  if (!profile) return apiError('not_found', 'no harness with that slug');

  return apiJson(profile, 200, { 'cache-control': 'public, max-age=60, s-maxage=300' });
}
