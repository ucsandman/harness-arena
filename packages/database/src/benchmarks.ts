import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { benchmarkCategories, makeId } from '@harness-arena/protocol';
import type { BenchmarkPack, BenchmarkVersionSummary, Visibility } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import { benchmarkTasks, benchmarkVersions, benchmarks } from './schema/arena.js';
import type { BenchmarkRow, BenchmarkTaskRow, BenchmarkVersionRow } from './schema/index.js';

/**
 * Benchmark packs in the catalogue.
 *
 * A pack's slug is global and owned by whoever published it first; a version is immutable and keyed
 * by the sha256 of its canonical content (`bmv_…`), so publishing the same content twice is a no-op
 * and publishing changed content only ever adds a row. Nothing here executes a benchmark: the
 * battles are produced by the CLI on a contributor's machine and uploaded separately.
 */

/** Publishing to a slug someone else owns. Carries the owner so the API can answer 403 with a reason. */
export class BenchmarkOwnershipError extends Error {
  readonly slug: string;
  readonly ownerUserId: string | null;

  constructor(slug: string, ownerUserId: string | null) {
    super('the benchmark slug "' + slug + '" belongs to another account');
    this.name = 'BenchmarkOwnershipError';
    this.slug = slug;
    this.ownerUserId = ownerUserId;
  }
}

export function battlesPerRun(pack: BenchmarkPack): number {
  return pack.tasks.reduce((total, task) => total + Math.max(1, task.trials), 0);
}

export function toVersionSummary(row: {
  benchmark: BenchmarkRow;
  version: BenchmarkVersionRow;
}): BenchmarkVersionSummary {
  return {
    versionId: row.version.id,
    slug: row.benchmark.slug,
    name: row.benchmark.name,
    version: row.version.version,
    description: row.benchmark.description,
    author: row.benchmark.author,
    categories: row.version.categories,
    taskCount: row.version.taskCount,
    battlesPerRun: row.version.battlesPerRun,
    visibility: row.benchmark.visibility,
    createdAt: row.version.createdAt.toISOString(),
  };
}

export interface PublishBenchmarkOptions {
  ownerUserId: string;
  /** `bmv_` + 24 hex chars, computed from the pack content by the protocol helper */
  versionId: string;
}

export interface PublishedBenchmark {
  benchmark: BenchmarkRow;
  version: BenchmarkVersionRow;
  summary: BenchmarkVersionSummary;
  /** false when this exact content was already published (the version id already existed) */
  created: boolean;
}

/**
 * Register a pack version. The slug row is created on first publish and never changes owner; a later
 * publish by the owner updates the display fields and moves `latestVersionId`.
 */
export async function publishBenchmark(
  db: ArenaDatabase,
  pack: BenchmarkPack,
  opts: PublishBenchmarkOptions,
): Promise<PublishedBenchmark> {
  const [existing] = await db.select().from(benchmarks).where(eq(benchmarks.slug, pack.slug)).limit(1);
  if (existing && existing.ownerUserId !== null && existing.ownerUserId !== opts.ownerUserId) {
    throw new BenchmarkOwnershipError(pack.slug, existing.ownerUserId);
  }

  const now = new Date();
  let benchmark: BenchmarkRow;
  if (existing) {
    const [updated] = await db
      .update(benchmarks)
      .set({
        name: pack.name,
        description: pack.description ?? null,
        author: pack.author ?? null,
        ownerUserId: existing.ownerUserId ?? opts.ownerUserId,
        visibility: pack.visibility,
        updatedAt: now,
      })
      .where(eq(benchmarks.id, existing.id))
      .returning();
    benchmark = updated as BenchmarkRow;
  } else {
    const [inserted] = await db
      .insert(benchmarks)
      .values({
        id: makeId('benchmark'),
        slug: pack.slug,
        name: pack.name,
        description: pack.description ?? null,
        author: pack.author ?? null,
        ownerUserId: opts.ownerUserId,
        visibility: pack.visibility,
      })
      .returning();
    benchmark = inserted as BenchmarkRow;
  }

  const [alreadyPublished] = await db
    .select()
    .from(benchmarkVersions)
    .where(eq(benchmarkVersions.id, opts.versionId))
    .limit(1);

  let version: BenchmarkVersionRow;
  if (alreadyPublished) {
    version = alreadyPublished;
  } else {
    const [inserted] = await db
      .insert(benchmarkVersions)
      .values({
        id: opts.versionId,
        benchmarkId: benchmark.id,
        version: pack.version,
        pack,
        taskCount: pack.tasks.length,
        battlesPerRun: battlesPerRun(pack),
        categories: benchmarkCategories(pack),
      })
      // the same content under a version label that already exists: the content hash is the identity
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      version = inserted;
      await db.insert(benchmarkTasks).values(
        pack.tasks.map((task, position) => ({
          versionId: opts.versionId,
          taskId: task.id,
          position,
          title: task.title,
          category: task.category,
          tags: task.tags,
          repositorySource: task.repository.source,
          repositoryCommit: task.repository.commit ?? null,
          trials: task.trials,
        })),
      );
    } else {
      const [conflicting] = await db
        .select()
        .from(benchmarkVersions)
        .where(
          and(eq(benchmarkVersions.benchmarkId, benchmark.id), eq(benchmarkVersions.version, pack.version)),
        )
        .limit(1);
      if (!conflicting) throw new Error('could not publish benchmark version ' + opts.versionId);
      version = conflicting;
    }
  }

  await db
    .update(benchmarks)
    .set({ latestVersionId: version.id, updatedAt: now })
    .where(eq(benchmarks.id, benchmark.id));
  benchmark = { ...benchmark, latestVersionId: version.id };

  return {
    benchmark,
    version,
    summary: toVersionSummary({ benchmark, version }),
    created: alreadyPublished === undefined,
  };
}

/** A private pack is readable only by its owner; unlisted and public are readable by anyone. */
function visibleToViewer(
  row: Pick<BenchmarkRow, 'visibility' | 'ownerUserId'>,
  viewerUserId?: string | null,
): boolean {
  if (row.visibility !== 'private') return true;
  return Boolean(viewerUserId) && row.ownerUserId === viewerUserId;
}

export interface BenchmarkDetail {
  benchmark: BenchmarkRow;
  version: BenchmarkVersionRow;
  pack: BenchmarkPack;
  tasks: BenchmarkTaskRow[];
  /** every version of this pack, newest first */
  versions: BenchmarkVersionSummary[];
}

export interface GetBenchmarkOptions {
  /** a specific version; omitted reads the pack's latest */
  versionId?: string;
  viewerUserId?: string | null;
}

/** One pack with the requested version, its tasks and its version history. Null when not visible. */
export async function getBenchmark(
  db: ArenaDatabase,
  slug: string,
  opts: GetBenchmarkOptions = {},
): Promise<BenchmarkDetail | null> {
  const [benchmark] = await db.select().from(benchmarks).where(eq(benchmarks.slug, slug)).limit(1);
  if (!benchmark || !visibleToViewer(benchmark, opts.viewerUserId)) return null;

  const allVersions = await db
    .select()
    .from(benchmarkVersions)
    .where(eq(benchmarkVersions.benchmarkId, benchmark.id))
    .orderBy(desc(benchmarkVersions.createdAt));

  const wanted = opts.versionId
    ? allVersions.find((row) => row.id === opts.versionId)
    : (allVersions.find((row) => row.id === benchmark.latestVersionId) ?? allVersions[0]);
  if (!wanted) return null;

  const tasks = await db
    .select()
    .from(benchmarkTasks)
    .where(eq(benchmarkTasks.versionId, wanted.id))
    .orderBy(benchmarkTasks.position);

  return {
    benchmark,
    version: wanted,
    pack: wanted.pack,
    tasks,
    versions: allVersions.map((version) => toVersionSummary({ benchmark, version })),
  };
}

/** One version by its content id, with the pack it carries. Null when not visible. */
export async function getBenchmarkVersion(
  db: ArenaDatabase,
  versionId: string,
  viewerUserId?: string | null,
): Promise<{
  benchmark: BenchmarkRow;
  version: BenchmarkVersionRow;
  summary: BenchmarkVersionSummary;
} | null> {
  const [row] = await db
    .select({ benchmark: benchmarks, version: benchmarkVersions })
    .from(benchmarkVersions)
    .innerJoin(benchmarks, eq(benchmarks.id, benchmarkVersions.benchmarkId))
    .where(eq(benchmarkVersions.id, versionId))
    .limit(1);
  if (!row || !visibleToViewer(row.benchmark, viewerUserId)) return null;
  return { benchmark: row.benchmark, version: row.version, summary: toVersionSummary(row) };
}

export interface ListBenchmarksOptions {
  /** only packs at this visibility; omitted lists everything the viewer may see */
  visibility?: Visibility;
  /** only packs whose latest version covers this category */
  category?: string;
  limit?: number;
  viewerUserId?: string | null;
}

export const BENCHMARK_LIST_LIMIT = 100;

/** The catalogue: the latest version of every pack the viewer may see, newest first. */
export async function listBenchmarks(
  db: ArenaDatabase,
  opts: ListBenchmarksOptions = {},
): Promise<BenchmarkVersionSummary[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), BENCHMARK_LIST_LIMIT);
  const viewer = opts.viewerUserId ?? null;
  const visible = viewer
    ? or(sql`${benchmarks.visibility} <> 'private'`, eq(benchmarks.ownerUserId, viewer))
    : sql`${benchmarks.visibility} <> 'private'`;
  const filters = [visible];
  if (opts.visibility) filters.push(eq(benchmarks.visibility, opts.visibility));

  const rows = await db
    .select({ benchmark: benchmarks, version: benchmarkVersions })
    .from(benchmarks)
    .innerJoin(benchmarkVersions, eq(benchmarkVersions.id, benchmarks.latestVersionId))
    .where(and(...filters))
    .orderBy(desc(benchmarkVersions.createdAt))
    .limit(limit);

  const filtered = opts.category
    ? rows.filter((row) => row.version.categories.includes(opts.category as string))
    : rows;
  return filtered.map(toVersionSummary);
}

/** The task rows of several versions at once, for a benchmark-filtered leaderboard. */
export async function listBenchmarkTasks(
  db: ArenaDatabase,
  versionIds: readonly string[],
): Promise<BenchmarkTaskRow[]> {
  if (versionIds.length === 0) return [];
  return db
    .select()
    .from(benchmarkTasks)
    .where(inArray(benchmarkTasks.versionId, [...versionIds]))
    .orderBy(benchmarkTasks.position);
}
