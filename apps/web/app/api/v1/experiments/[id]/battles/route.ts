/**
 * Link an uploaded battle to an experiment. Owner-only: only the account that created the experiment
 * may attach evidence to it. The battle must actually have run the control and the treatment the
 * experiment names; a label is never trusted, only the harness sources recorded on the runs.
 */
import { z } from 'zod';
import { linkBattleRequestSchema } from '@harness-arena/protocol';
import { ExperimentLinkError, getExperiment, linkBattleToExperiment } from '@harness-arena/database';
import { apiError, apiJson, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

const linkExperimentBattleRequestSchema = linkBattleRequestSchema.extend({
  treatmentSide: z.enum(['a', 'b']).default('b'),
});

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

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(linkExperimentBattleRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;
  const { battleId, treatmentSide } = parsed.data;

  try {
    const linked = await linkBattleToExperiment(dbh, id, battleId, treatmentSide);
    return apiJson({ battleId: linked.battleId, treatmentSide: linked.treatmentSide, experimentId: id });
  } catch (err) {
    if (err instanceof ExperimentLinkError) return apiError('invalid_request', err.reason);
    throw err;
  }
}
