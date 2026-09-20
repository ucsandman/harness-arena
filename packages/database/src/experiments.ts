import { and, desc, eq, inArray } from 'drizzle-orm';
import { makeId } from '@harness-arena/protocol';
import type { CreateExperimentRequest, Experiment, ExperimentSummary, Side } from '@harness-arena/protocol';
import { computeExperimentSummary } from '@harness-arena/evaluator';
import type { ExperimentBattleInput } from '@harness-arena/evaluator';
import type { ArenaDatabase } from './client.js';
import { battleLinks, experiments } from './schema/arena.js';
import { battles } from './schema/battles.js';
import { harnesses } from './schema/catalog.js';
import { users } from './schema/identity.js';
import type { ExperimentRow } from './schema/index.js';
import { refFromCompetitor, refFromRun, sameHarness, slugForCompetitor } from './arena-refs.js';

/**
 * Experiments: control vs treatment over the same tasks.
 *
 * The summary is a pure function of the linked battle records (`computeExperimentSummary`), so the
 * CLI computes exactly the same numbers offline that the server shows, and every sentence it
 * produces carries the sample it came from. Arena runs nothing: the battles were produced locally
 * with the contributor's own agent CLIs and uploaded afterwards.
 */

/** A battle whose competitors do not match the experiment's control and treatment. */
export class ExperimentLinkError extends Error {
  readonly experimentId: string;
  readonly battleId: string;
  readonly reason: string;

  constructor(experimentId: string, battleId: string, reason: string) {
    super('battle ' + battleId + ' cannot be linked to experiment ' + experimentId + ': ' + reason);
    this.name = 'ExperimentLinkError';
    this.experimentId = experimentId;
    this.battleId = battleId;
    this.reason = reason;
  }
}

// ---- pure summary ------------------------------------------------------------------------------

/**
 * The summary maths lives in @harness-arena/evaluator so the CLI can compute it offline without a
 * database driver, and is re-exported here because the server reads it from this module.
 */
export { computeExperimentSummary, correctnessOf, CORRECTNESS_FACTORS } from '@harness-arena/evaluator';
export type { ExperimentBattleInput } from '@harness-arena/evaluator';

// ---- persistence -------------------------------------------------------------------------------

function benchmarkVersionOf(target: CreateExperimentRequest['target']): string | null {
  return target.kind === 'benchmark' ? target.versionId : null;
}

export interface CreateExperimentOptions {
  createdByUserId: string;
}

async function harnessIdForSlug(db: ArenaDatabase, slug: string): Promise<string | null> {
  const [row] = await db
    .select({ id: harnesses.id })
    .from(harnesses)
    .where(eq(harnesses.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

export async function createExperiment(
  db: ArenaDatabase,
  req: CreateExperimentRequest,
  opts: CreateExperimentOptions,
): Promise<Experiment> {
  const controlSlug = slugForCompetitor(req.control);
  const treatmentSlug = slugForCompetitor(req.treatment);
  // regression and ablation compare one harness with itself, so the catalogue row is the same one
  const harnessId = controlSlug === treatmentSlug ? await harnessIdForSlug(db, controlSlug) : null;

  const [row] = await db
    .insert(experiments)
    .values({
      id: makeId('experiment'),
      title: req.title,
      kind: req.kind,
      status: 'running',
      createdByUserId: opts.createdByUserId,
      control: req.control,
      treatment: req.treatment,
      harnessId,
      changedComponent: req.changedComponent ?? null,
      componentId: req.changedComponent
        ? req.changedComponent.kind + '/' + req.changedComponent.name.toLowerCase()
        : null,
      agent: req.agent,
      target: req.target,
      benchmarkVersionId: benchmarkVersionOf(req.target),
      trials: req.trials,
      visibility: req.visibility,
    })
    .returning();

  const experiment = await toExperiment(db, row as ExperimentRow);
  return experiment;
}

async function battleIdsFor(db: ArenaDatabase, experimentId: string): Promise<string[]> {
  const rows = await db
    .select({ battleId: battleLinks.battleId, createdAt: battleLinks.createdAt })
    .from(battleLinks)
    .where(and(eq(battleLinks.kind, 'experiment'), eq(battleLinks.targetId, experimentId)))
    .orderBy(battleLinks.createdAt);
  return rows.map((row) => row.battleId);
}

async function toExperiment(db: ArenaDatabase, row: ExperimentRow): Promise<Experiment> {
  let createdBy: Experiment['createdBy'] = null;
  if (row.createdByUserId) {
    const [user] = await db
      .select({ id: users.id, login: users.login })
      .from(users)
      .where(eq(users.id, row.createdByUserId))
      .limit(1);
    createdBy = user ? { id: user.id, login: user.login } : null;
  }
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    createdBy,
    control: row.control,
    treatment: row.treatment,
    changedComponent: row.changedComponent ?? null,
    agent: row.agent,
    target: row.target,
    trials: row.trials,
    visibility: row.visibility,
    battleIds: await battleIdsFor(db, row.id),
    summary: row.summary ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/** One experiment. A private experiment is readable only by the account that created it. */
export async function getExperiment(
  db: ArenaDatabase,
  id: string,
  viewerUserId?: string | null,
): Promise<Experiment | null> {
  const [row] = await db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  if (!row) return null;
  if (row.visibility === 'private' && (!viewerUserId || row.createdByUserId !== viewerUserId)) return null;
  return toExperiment(db, row);
}

export interface ListExperimentsOptions {
  /** catalogue slug of the harness under test (regression and ablation only) */
  harnessSlug?: string;
  /** `<kind>/<name>` of the component an ablation changed */
  componentSlug?: string;
  limit?: number;
  viewerUserId?: string | null;
}

export const EXPERIMENT_LIST_LIMIT = 100;

export async function listExperiments(
  db: ArenaDatabase,
  opts: ListExperimentsOptions = {},
): Promise<Experiment[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), EXPERIMENT_LIST_LIMIT);
  const filters = [];
  if (opts.harnessSlug) {
    const harnessId = await harnessIdForSlug(db, opts.harnessSlug);
    if (!harnessId) return [];
    filters.push(eq(experiments.harnessId, harnessId));
  }
  if (opts.componentSlug) filters.push(eq(experiments.componentId, opts.componentSlug.toLowerCase()));

  const rows = await db
    .select()
    .from(experiments)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(experiments.createdAt))
    .limit(limit);

  const viewer = opts.viewerUserId ?? null;
  const visible = rows.filter(
    (row) => row.visibility !== 'private' || (viewer !== null && row.createdByUserId === viewer),
  );
  return Promise.all(visible.map((row) => toExperiment(db, row)));
}

/**
 * Link an uploaded battle to an experiment, after checking that the battle really ran the control and
 * the treatment the experiment names. A label is never trusted: the harness sources recorded on the
 * runs are what is compared.
 */
export async function linkBattleToExperiment(
  db: ArenaDatabase,
  experimentId: string,
  battleId: string,
  treatmentSide: Side,
): Promise<{ battleId: string; treatmentSide: Side }> {
  const [experiment] = await db.select().from(experiments).where(eq(experiments.id, experimentId)).limit(1);
  if (!experiment) throw new ExperimentLinkError(experimentId, battleId, 'no such experiment');

  const [battle] = await db.select().from(battles).where(eq(battles.id, battleId)).limit(1);
  if (!battle) throw new ExperimentLinkError(experimentId, battleId, 'no such battle');

  const record = battle.record;
  const controlSide: Side = treatmentSide === 'a' ? 'b' : 'a';
  const treatmentRun = refFromRun(record.runs[treatmentSide].harness);
  const controlRun = refFromRun(record.runs[controlSide].harness);
  if (!sameHarness(controlRun, refFromCompetitor(experiment.control))) {
    throw new ExperimentLinkError(
      experimentId,
      battleId,
      'side ' +
        controlSide +
        ' ran ' +
        controlRun.source +
        ', not the control ' +
        experiment.control.harness.source,
    );
  }
  if (!sameHarness(treatmentRun, refFromCompetitor(experiment.treatment))) {
    throw new ExperimentLinkError(
      experimentId,
      battleId,
      'side ' +
        treatmentSide +
        ' ran ' +
        treatmentRun.source +
        ', not the treatment ' +
        experiment.treatment.harness.source,
    );
  }

  await db
    .insert(battleLinks)
    .values({ battleId, kind: 'experiment', targetId: experimentId, treatmentSide })
    .onConflictDoUpdate({
      target: [battleLinks.battleId, battleLinks.kind],
      set: { targetId: experimentId, treatmentSide },
    });
  return { battleId, treatmentSide };
}

/** Recompute the summary from every battle linked to the experiment. */
export async function summarizeExperiment(db: ArenaDatabase, id: string): Promise<ExperimentSummary> {
  const links = await db
    .select({ battleId: battleLinks.battleId, treatmentSide: battleLinks.treatmentSide })
    .from(battleLinks)
    .where(and(eq(battleLinks.kind, 'experiment'), eq(battleLinks.targetId, id)))
    .orderBy(battleLinks.createdAt);
  if (links.length === 0) return computeExperimentSummary([]);

  const rows = await db
    .select({ id: battles.id, record: battles.record })
    .from(battles)
    .where(
      inArray(
        battles.id,
        links.map((link) => link.battleId),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row.record]));

  const inputs: ExperimentBattleInput[] = [];
  for (const link of links) {
    const record = byId.get(link.battleId);
    if (!record) continue;
    inputs.push({ record, treatmentSide: (link.treatmentSide ?? 'b') as Side });
  }
  return computeExperimentSummary(inputs);
}

/** Close an experiment: store the summary computed from its battles and stamp it completed. */
export async function finalizeExperiment(db: ArenaDatabase, id: string): Promise<Experiment | null> {
  const [row] = await db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  if (!row) return null;
  const summary = await summarizeExperiment(db, id);
  const completedAt = new Date();
  const [updated] = await db
    .update(experiments)
    .set({ status: 'completed', summary, completedAt, updatedAt: completedAt })
    .where(eq(experiments.id, id))
    .returning();
  return toExperiment(db, updated as ExperimentRow);
}
