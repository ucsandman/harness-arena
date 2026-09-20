import { eq, inArray } from 'drizzle-orm';
import type { HarnessManifest, LineageEdge, LineageEvidence, LineageRelation } from '@harness-arena/protocol';
import { makeId } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import { harnessLineage, harnesses } from './schema/index.js';
import { normalizeSource, slugForSourceUrl } from './arena-refs.js';

/**
 * Harness ancestry. Arena never infers a relationship: an edge exists only because GitHub says the
 * repository is a fork (`github_fork`, read once during import), because the harness own arena.yaml
 * declares it (`manifest`), or because a person stated it (`declared`). The evidence value travels
 * with the edge all the way to the page, so a reader can weigh it.
 */

export interface DeclaredLineage {
  relation: LineageRelation;
  /** the parent's URL exactly as declared; kept even when no catalogue row matches it */
  parentSource: string;
  evidence: LineageEvidence;
}

/** arena.yaml `lineage:` -> edges. Pure; the manifest is the only source. */
export function lineageFromManifest(manifest: HarnessManifest | null | undefined): DeclaredLineage[] {
  const lineage = manifest?.lineage;
  if (!lineage) return [];
  const edges: DeclaredLineage[] = [];
  if (lineage.forkedFrom) {
    edges.push({ relation: 'forked_from', parentSource: lineage.forkedFrom, evidence: 'manifest' });
  }
  for (const source of lineage.derivedFrom ?? []) {
    edges.push({ relation: 'derived_from', parentSource: source, evidence: 'manifest' });
  }
  for (const source of lineage.basedOn ?? []) {
    edges.push({ relation: 'based_on', parentSource: source, evidence: 'manifest' });
  }
  return edges;
}

/** GitHub repository JSON -> at most one `forked_from` edge. Pure. */
export function lineageFromGithub(repo: {
  fork?: boolean;
  parent?: { html_url?: string | null } | null;
}): DeclaredLineage[] {
  if (repo.fork !== true) return [];
  const url = repo.parent?.html_url;
  if (typeof url !== 'string' || url.trim().length === 0) return [];
  return [{ relation: 'forked_from', parentSource: url.trim(), evidence: 'github_fork' }];
}

/** The catalogue row a declared parent URL points at, by slug first and then by stored source URL. */
async function resolveParent(db: ArenaDatabase, parentSource: string): Promise<string | null> {
  const slug = slugForSourceUrl(parentSource);
  const [bySlug] = await db
    .select({ id: harnesses.id })
    .from(harnesses)
    .where(eq(harnesses.slug, slug))
    .limit(1);
  if (bySlug) return bySlug.id;
  const wanted = normalizeSource(parentSource);
  const rows = await db.select({ id: harnesses.id, sourceUrl: harnesses.sourceUrl }).from(harnesses);
  for (const row of rows) {
    if (row.sourceUrl && normalizeSource(row.sourceUrl) === wanted) return row.id;
  }
  return null;
}

/**
 * Store edges for one harness. The unique key is (harness, relation, parentSource), so re-importing a
 * repository or re-uploading a battle converges instead of duplicating; a parent that only appears in
 * the catalogue later is re-linked on the next call.
 */
export async function recordLineage(
  db: ArenaDatabase,
  harnessId: string,
  edges: readonly DeclaredLineage[],
): Promise<number> {
  if (edges.length === 0) return 0;
  let written = 0;
  for (const edge of edges) {
    const parentHarnessId = await resolveParent(db, edge.parentSource);
    // a harness is never its own ancestor, however the manifest is written
    if (parentHarnessId === harnessId) continue;
    await db
      .insert(harnessLineage)
      .values({
        id: makeId('lineage'),
        harnessId,
        relation: edge.relation,
        parentHarnessId,
        parentSource: edge.parentSource,
        evidence: edge.evidence,
      })
      .onConflictDoUpdate({
        target: [harnessLineage.harnessId, harnessLineage.relation, harnessLineage.parentSource],
        set: { parentHarnessId, evidence: edge.evidence },
      });
    written += 1;
  }
  return written;
}

export interface Lineage {
  /** edges this harness declares about its own parents */
  ancestors: LineageEdge[];
  /** edges other harnesses declare that name this one */
  descendants: LineageEdge[];
}

export async function getLineage(db: ArenaDatabase, slug: string): Promise<Lineage | null> {
  const [harness] = await db
    .select({ id: harnesses.id, slug: harnesses.slug })
    .from(harnesses)
    .where(eq(harnesses.slug, slug))
    .limit(1);
  if (!harness) return null;

  const [up, down] = await Promise.all([
    db.select().from(harnessLineage).where(eq(harnessLineage.harnessId, harness.id)),
    db.select().from(harnessLineage).where(eq(harnessLineage.parentHarnessId, harness.id)),
  ]);

  const ids = new Set<string>();
  for (const row of up) if (row.parentHarnessId) ids.add(row.parentHarnessId);
  for (const row of down) ids.add(row.harnessId);
  const slugs = new Map<string, string>();
  if (ids.size > 0) {
    const rows = await db
      .select({ id: harnesses.id, slug: harnesses.slug })
      .from(harnesses)
      .where(inArray(harnesses.id, [...ids]));
    for (const row of rows) slugs.set(row.id, row.slug);
  }

  return {
    ancestors: up.map((row) => ({
      harnessSlug: harness.slug,
      relation: row.relation,
      parentSlug: row.parentHarnessId ? (slugs.get(row.parentHarnessId) ?? null) : null,
      parentSource: row.parentSource,
      evidence: row.evidence,
      createdAt: row.createdAt.toISOString(),
    })),
    descendants: down.map((row) => ({
      harnessSlug: slugs.get(row.harnessId) ?? row.harnessId,
      relation: row.relation,
      parentSlug: harness.slug,
      parentSource: row.parentSource,
      evidence: row.evidence,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
