/**
 * The benchmark catalogue: publish a pack version, list what is visible to the caller.
 * Reads are public (visibility gates private packs); publishing needs a device token, and a slug is
 * owned by whoever published it first.
 */
import {
  benchmarkVersionId,
  uploadBenchmarkRequestSchema,
  uploadBenchmarkResponseSchema,
  type Visibility,
} from '@harness-arena/protocol';
import { BenchmarkOwnershipError, listBenchmarks, publishBenchmark } from '@harness-arena/database';
import { apiError, apiJson, optionalViewer, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const VISIBILITIES = ['private', 'unlisted', 'public'] as const;

function parseVisibility(raw: string | null): Visibility | undefined {
  return raw && (VISIBILITIES as readonly string[]).includes(raw) ? (raw as Visibility) : undefined;
}

/** Every benchmark pack visible to the caller, newest first. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const viewer = await optionalViewer(request);
  const limitParam = Number(url.searchParams.get('limit') ?? '');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined;

  const dbh = await db();
  const benchmarks = await listBenchmarks(dbh, {
    visibility: parseVisibility(url.searchParams.get('visibility')),
    category: url.searchParams.get('category') ?? undefined,
    limit,
    viewerUserId: viewer.userId,
  });
  return apiJson({ benchmarks, count: benchmarks.length });
}

/** Publish a pack version. Re-publishing identical content is a no-op; the slug never changes owner. */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(uploadBenchmarkRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;
  const { pack } = parsed.data;

  const versionId = await benchmarkVersionId(pack);
  const dbh = await db();
  try {
    const published = await publishBenchmark(dbh, pack, { ownerUserId: auth.auth.user.id, versionId });
    const response = uploadBenchmarkResponseSchema.parse({
      versionId: published.version.id,
      slug: published.benchmark.slug,
      version: published.version.version,
      created: published.created,
      url: absoluteUrl('/benchmarks/' + published.benchmark.slug),
    });
    return apiJson(response, published.created ? 201 : 200);
  } catch (err) {
    if (err instanceof BenchmarkOwnershipError) return apiError('forbidden', err.message);
    throw err;
  }
}
