/**
 * Read one experiment. A private experiment is readable only by the account that created it.
 */
import { experimentSchema } from '@harness-arena/protocol';
import { getExperiment } from '@harness-arena/database';
import { apiError, apiJson, optionalViewer } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, ctx: Context): Promise<Response> {
  const { id } = await ctx.params;
  const viewer = await optionalViewer(request);

  const dbh = await db();
  const experiment = await getExperiment(dbh, id, viewer.userId);
  if (!experiment) return apiError('not_found', 'no experiment with that id is visible to you');

  return apiJson({ experiment: experimentSchema.parse(experiment), url: absoluteUrl('/experiments/' + id) });
}
