import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type {
  ComponentDetail,
  ComponentEvidence,
  ComponentKind,
  ComponentSummary,
  HarnessManifest,
} from '@harness-arena/protocol';
import { makeId } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import type { ComponentRow, ExperimentRow } from './schema/index.js';
import {
  battleLinks,
  components,
  experiments,
  harnessComponents,
  harnessVersions,
  harnesses,
} from './schema/index.js';

/**
 * The component catalogue: the reusable parts a harness declares in arena.yaml (`components:`), and
 * what experiments have measured about them.
 *
 * Evidence is never asserted. A component's numbers are the mean of the experiment summaries that name
 * it as the one thing that changed, and a component nobody has experimented on reports null averages
 * with n = 0 rather than a zero.
 */

export const COMPONENT_LIST_LIMIT = 100;
const COMPONENT_LIST_MAX = 500;
/** how many experiments one catalogue read will scan for evidence */
const EXPERIMENT_SCAN_CAP = 2000;

/** `<kind>/<name>`, lowercased. The catalogue key, stable across harnesses that share a component. */
export function componentSlug(kind: string, name: string): string {
  return `${kind}/${name}`.toLowerCase().trim();
}

/**
 * Write the components an arena.yaml declares and attach them to one harness version. Idempotent:
 * re-uploading the same battle or re-importing the same commit converges on the same rows.
 */
export async function upsertComponentsFromManifest(
  db: ArenaDatabase,
  harnessVersionId: string,
  manifest: HarnessManifest | null | undefined,
): Promise<number> {
  const declared = manifest?.components ?? [];
  if (declared.length === 0) return 0;
  let written = 0;
  for (const entry of declared) {
    const slug = componentSlug(entry.kind, entry.name);
    const [row] = await db
      .insert(components)
      .values({
        id: makeId('component'),
        kind: entry.kind,
        slug,
        name: entry.name,
        description: entry.description ?? null,
        source: entry.source ?? null,
      })
      .onConflictDoUpdate({
        target: components.slug,
        set: {
          name: entry.name,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.source ? { source: entry.source } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({ id: components.id });
    if (!row) continue;
    await db
      .insert(harnessComponents)
      .values({ harnessVersionId, componentId: row.id, path: entry.path ?? null })
      .onConflictDoNothing({ target: [harnessComponents.harnessVersionId, harnessComponents.componentId] });
    written += 1;
  }
  return written;
}

// ---- evidence -----------------------------------------------------------------------------------

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 1000) / 1000;
}

function evidenceFrom(rows: readonly ExperimentRow[]): ComponentEvidence {
  const summarized = rows.filter((row) => row.status === 'completed' && row.summary !== null);
  const correctness = summarized
    .map((row) => row.summary?.correctness.deltaPoints)
    .filter((value): value is number => typeof value === 'number');
  const tokens = summarized
    .map((row) => row.summary?.tokens.deltaPercent)
    .filter((value): value is number => typeof value === 'number');
  return {
    experiments: rows.length,
    summarized: summarized.length,
    correctnessDeltaPoints: mean(correctness),
    tokenDeltaPercent: mean(tokens),
  };
}

/**
 * Experiments grouped by the component slug their `changedComponent` names. Matching happens in JS on
 * kind + name so it behaves the same on Postgres and on PGlite, and so it stays correct if an
 * experiment was written before the component row existed.
 */
async function experimentsByComponent(db: ArenaDatabase): Promise<Map<string, ExperimentRow[]>> {
  const rows = await db
    .select()
    .from(experiments)
    .where(isNotNull(experiments.changedComponent))
    .orderBy(desc(experiments.createdAt))
    .limit(EXPERIMENT_SCAN_CAP);
  const byComponent = new Map<string, ExperimentRow[]>();
  for (const row of rows) {
    const changed = row.changedComponent;
    if (!changed) continue;
    const slug = componentSlug(changed.kind, changed.name);
    const list = byComponent.get(slug) ?? [];
    list.push(row);
    byComponent.set(slug, list);
  }
  return byComponent;
}

/** Distinct harnesses (not versions) declaring each of the given components. */
async function harnessCounts(
  db: ArenaDatabase,
  componentIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (componentIds.length === 0) return counts;
  const rows = await db
    .select({ componentId: harnessComponents.componentId, harnessId: harnessVersions.harnessId })
    .from(harnessComponents)
    .innerJoin(harnessVersions, eq(harnessVersions.id, harnessComponents.harnessVersionId))
    .where(inArray(harnessComponents.componentId, [...componentIds]));
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = seen.get(row.componentId) ?? new Set<string>();
    set.add(row.harnessId);
    seen.set(row.componentId, set);
  }
  for (const [componentId, set] of seen) counts.set(componentId, set.size);
  return counts;
}

function toSummary(row: ComponentRow, harnessCount: number, evidence: ComponentEvidence): ComponentSummary {
  return {
    slug: row.slug,
    kind: row.kind,
    name: row.name,
    description: row.description,
    source: row.source,
    harnesses: harnessCount,
    evidence,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListComponentsOptions {
  kind?: ComponentKind;
  limit?: number;
}

export async function listComponents(
  db: ArenaDatabase,
  opts: ListComponentsOptions = {},
): Promise<ComponentSummary[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? COMPONENT_LIST_LIMIT), COMPONENT_LIST_MAX);
  const rows = await db
    .select()
    .from(components)
    .where(opts.kind ? eq(components.kind, opts.kind) : undefined)
    .orderBy(desc(components.createdAt))
    .limit(limit);
  const [counts, byComponent] = await Promise.all([
    harnessCounts(
      db,
      rows.map((row) => row.id),
    ),
    experimentsByComponent(db),
  ]);
  return rows.map((row) =>
    toSummary(row, counts.get(row.id) ?? 0, evidenceFrom(byComponent.get(row.slug) ?? [])),
  );
}

export async function getComponent(db: ArenaDatabase, slug: string): Promise<ComponentDetail | null> {
  const [row] = await db.select().from(components).where(eq(components.slug, slug)).limit(1);
  if (!row) return null;

  const harnessRows = await db
    .select({
      slug: harnesses.slug,
      name: harnesses.name,
      commit: harnessVersions.commit,
      path: harnessComponents.path,
    })
    .from(harnessComponents)
    .innerJoin(harnessVersions, eq(harnessVersions.id, harnessComponents.harnessVersionId))
    .innerJoin(harnesses, eq(harnesses.id, harnessVersions.harnessId))
    .where(eq(harnessComponents.componentId, row.id));

  const byComponent = await experimentsByComponent(db);
  const experimentRows = byComponent.get(row.slug) ?? [];

  const battleCounts = new Map<string, number>();
  if (experimentRows.length > 0) {
    const links = await db
      .select({ targetId: battleLinks.targetId })
      .from(battleLinks)
      .where(
        and(
          eq(battleLinks.kind, 'experiment'),
          inArray(
            battleLinks.targetId,
            experimentRows.map((experiment) => experiment.id),
          ),
        ),
      );
    for (const link of links) battleCounts.set(link.targetId, (battleCounts.get(link.targetId) ?? 0) + 1);
  }

  const distinctHarnesses = new Set(harnessRows.map((entry) => entry.slug));
  return {
    ...toSummary(row, distinctHarnesses.size, evidenceFrom(experimentRows)),
    harnessList: harnessRows.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      commit: entry.commit,
      path: entry.path,
    })),
    experimentList: experimentRows.map((experiment) => ({
      id: experiment.id,
      title: experiment.title,
      kind: experiment.kind,
      status: experiment.status,
      battles: battleCounts.get(experiment.id) ?? 0,
      correctnessDeltaPoints: experiment.summary?.correctness.deltaPoints ?? null,
      tokenDeltaPercent: experiment.summary?.tokens.deltaPercent ?? null,
      createdAt: experiment.createdAt.toISOString(),
    })),
  };
}
