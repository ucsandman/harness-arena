import { z } from 'zod';
import { harnessInsightSchema } from '@harness-arena/protocol';
import { getHarnessBySlug, getHarnessInsights } from '@harness-arena/database';
import { apiError, apiJson } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string }>;
}

// No protocol schema names this whole response shape (only its array element, harnessInsightSchema),
// so it is declared locally.
const insightsResponseSchema = z.object({
  slug: z.string(),
  insights: z.array(harnessInsightSchema),
  note: z.string(),
});

const INSIGHTS_NOTE =
  'Deterministic: every sentence is derived directly from this harness profile numbers (getHarnessProfile), ' +
  'with no model involved. Same input, same output, every time.';

/** GET /api/v1/harnesses/:slug/insights — public read, no auth. */
export async function GET(_request: Request, ctx: Context): Promise<Response> {
  const { slug } = await ctx.params;

  const dbh = await db();
  const harness = await getHarnessBySlug(dbh, slug);
  if (!harness) return apiError('not_found', 'no harness with that slug');

  const { insights } = await getHarnessInsights(dbh, slug);
  const response = insightsResponseSchema.parse({
    slug,
    insights: insights.map((insight) => ({ kind: insight.kind, text: insight.text, n: insight.support.n })),
    note: INSIGHTS_NOTE,
  });
  return apiJson(response, 200, { 'cache-control': 'public, max-age=60, s-maxage=300' });
}
