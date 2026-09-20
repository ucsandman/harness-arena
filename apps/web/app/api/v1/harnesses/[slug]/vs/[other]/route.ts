import { headToHeadFilterSchema, headToHeadSchema } from '@harness-arena/protocol';
import { getHeadToHead } from '@harness-arena/database';
import { apiError, apiJson, parseWith } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string; other: string }>;
}

/** GET /api/v1/harnesses/:slug/vs/:other — the pair's real record, public read, no auth. */
export async function GET(request: Request, ctx: Context): Promise<Response> {
  const { slug, other } = await ctx.params;
  const searchParams = new URL(request.url).searchParams;

  // omit absent keys entirely rather than passing nulls, so an unset filter stays unset in the schema
  const raw: Record<string, string> = {};
  const agentId = searchParams.get('agent');
  if (agentId !== null) raw.agentId = agentId;
  const category = searchParams.get('category');
  if (category !== null) raw.category = category;
  const pool = searchParams.get('pool');
  if (pool !== null) raw.pool = pool;
  const benchmarkSlug = searchParams.get('benchmark');
  if (benchmarkSlug !== null) raw.benchmarkSlug = benchmarkSlug;
  const commit = searchParams.get('commit');
  if (commit !== null) raw.commit = commit;
  const since = searchParams.get('since');
  if (since !== null) raw.since = since;
  const until = searchParams.get('until');
  if (until !== null) raw.until = until;

  const parsed = parseWith(headToHeadFilterSchema, raw);
  if (!parsed.ok) return parsed.response;

  const dbh = await db();
  const result = await getHeadToHead(dbh, slug, other, parsed.data);
  if (!result) return apiError('not_found', 'unknown harness on one or both sides');

  return apiJson(headToHeadSchema.parse(result), 200, {
    'cache-control': 'public, max-age=60, s-maxage=300',
  });
}
