/**
 * A harness's declared ancestry. Arena never infers a relationship: every edge came from GitHub fork
 * metadata, from the harness's own arena.yaml, or from a person saying so, and the evidence value
 * travels with it. Public read, no auth.
 */
import { lineageResponseSchema, LINEAGE_EVIDENCE_NOTE } from '@harness-arena/protocol';
import { getLineage } from '@harness-arena/database';
import { apiError, apiJson } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string }>;
}

export async function GET(_request: Request, ctx: Context): Promise<Response> {
  const { slug } = await ctx.params;

  const dbh = await db();
  const lineage = await getLineage(dbh, slug);
  if (!lineage) return apiError('not_found', 'no harness with that slug');

  return apiJson(
    lineageResponseSchema.parse({
      harnessSlug: slug,
      ancestors: lineage.ancestors,
      descendants: lineage.descendants,
      evidenceNote: LINEAGE_EVIDENCE_NOTE,
    }),
  );
}
