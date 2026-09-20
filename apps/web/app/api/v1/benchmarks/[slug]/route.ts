/**
 * One benchmark pack: the requested version (or the latest), its tasks, and the full version history.
 * A private pack is readable only by its owner.
 */
import { benchmarkPackSchema } from '@harness-arena/protocol';
import { getBenchmark, toVersionSummary } from '@harness-arena/database';
import { apiError, apiJson, optionalViewer } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string }>;
}

export async function GET(request: Request, ctx: Context): Promise<Response> {
  const { slug } = await ctx.params;
  const url = new URL(request.url);
  const viewer = await optionalViewer(request);

  const dbh = await db();
  const found = await getBenchmark(dbh, slug, {
    versionId: url.searchParams.get('version') ?? undefined,
    viewerUserId: viewer.userId,
  });
  if (!found) return apiError('not_found', 'no benchmark pack with that slug is visible to you');

  const pack = benchmarkPackSchema.parse(found.pack);
  const tasks = found.tasks.map((task) => ({
    taskId: task.taskId,
    position: task.position,
    title: task.title,
    category: task.category,
    tags: task.tags,
    repositorySource: task.repositorySource,
    repositoryCommit: task.repositoryCommit,
    trials: task.trials,
  }));

  return apiJson({
    benchmark: toVersionSummary({ benchmark: found.benchmark, version: found.version }),
    pack,
    tasks,
    versions: found.versions,
  });
}
