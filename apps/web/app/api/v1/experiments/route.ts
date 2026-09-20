/**
 * Experiments: control vs treatment over the same tasks. Reads are public (visibility gates private
 * experiments); creating one needs a device token, and the caller becomes its owner.
 */
import { createExperimentRequestSchema, experimentSchema } from '@harness-arena/protocol';
import { createExperiment, listExperiments } from '@harness-arena/database';
import { apiJson, optionalViewer, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Experiments visible to the caller, newest first, optionally filtered by harness or component. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const viewer = await optionalViewer(request);
  const limitParam = Number(url.searchParams.get('limit') ?? '');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined;

  const dbh = await db();
  const experiments = await listExperiments(dbh, {
    harnessSlug: url.searchParams.get('harness') ?? undefined,
    componentSlug: url.searchParams.get('component') ?? undefined,
    limit,
    viewerUserId: viewer.userId,
  });
  return apiJson({ experiments, count: experiments.length });
}

/** Create an experiment. Only its creator may link battles to it or finalize it. */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(createExperimentRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const dbh = await db();
  const experiment = await createExperiment(dbh, parsed.data, { createdByUserId: auth.auth.user.id });
  return apiJson(
    { experiment: experimentSchema.parse(experiment), url: absoluteUrl('/experiments/' + experiment.id) },
    201,
  );
}
