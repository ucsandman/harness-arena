/**
 * Close an experiment: compute its summary from every battle linked to it and stamp it completed.
 * Owner-only: only the account that created the experiment may finalize it.
 */
import { experimentSchema } from '@harness-arena/protocol';
import { finalizeExperiment, getExperiment } from '@harness-arena/database';
import { apiError, apiJson, requireDevice } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, ctx: Context): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const dbh = await db();
  const experiment = await getExperiment(dbh, id, auth.auth.user.id);
  if (!experiment) return apiError('not_found', 'no experiment with that id');
  if (experiment.createdBy?.id !== auth.auth.user.id) {
    return apiError('forbidden', 'that experiment belongs to another account');
  }

  const finalized = await finalizeExperiment(dbh, id);
  if (!finalized) return apiError('not_found', 'no experiment with that id');

  return apiJson({ experiment: experimentSchema.parse(finalized), url: absoluteUrl('/experiments/' + id) });
}
