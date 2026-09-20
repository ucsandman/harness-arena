import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  BattleRecord,
  Bounty,
  BountyCondition,
  BountyStatus,
  BountySubmission,
  CompetitorRef,
  CreateBountyRequest,
  MetricKey,
  Side,
} from '@harness-arena/protocol';
import { makeId } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import type { BountyRow, BountySubmissionRow } from './schema/index.js';
import {
  battleLinks,
  battles,
  benchmarkVersions,
  bounties,
  bountySubmissions,
  harnesses,
  users,
} from './schema/index.js';
import { refFromCompetitor, refFromRun, sameHarness, slugForCompetitor } from './arena-refs.js';

/**
 * Bounties: "beat this baseline on this task and I will say so publicly".
 *
 * Arena moves no money and runs no battle. A submitter runs the work locally, uploads the battles
 * against their submission, and `evaluateSubmission` recomputes the bounty's condition from those
 * battles with pure arithmetic. `evaluateBountyCondition` is exported and pure so the same numbers can
 * be checked in a test, in the CLI, or by hand.
 */

export const BOUNTY_LIST_LIMIT = 50;
const BOUNTY_LIST_MAX = 200;

// ---- the condition, as pure arithmetic ------------------------------------------------------------

export interface BountyBattle {
  record: BattleRecord;
  /** which side of that battle was the submission; the other side is the baseline */
  submissionSide: Side;
}

export interface BountyConditionResult {
  met: boolean;
  battles: number;
  /** one line per check, each carrying the numbers it was decided on */
  reasons: string[];
}

function otherSide(side: Side): Side {
  return side === 'a' ? 'b' : 'a';
}

function metricValue(record: BattleRecord, side: Side, key: MetricKey): number | null {
  const metric = record.runs[side].metrics[key];
  if (!metric || metric.status === 'unavailable') return null;
  return typeof metric.value === 'number' ? metric.value : null;
}

function durationValue(record: BattleRecord, side: Side): number | null {
  const direct = record.runs[side].durationMs;
  if (typeof direct === 'number') return direct;
  return metricValue(record, side, 'duration_ms');
}

interface Check {
  ok: boolean;
  reason: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * submission metric / baseline metric on each battle where both sides reported it. The worst (highest)
 * ratio decides, so "at most 80% of baseline tokens" must hold on every comparable battle.
 */
function ratioCheck(
  label: string,
  limit: number,
  list: readonly BountyBattle[],
  read: (record: BattleRecord, side: Side) => number | null,
): Check {
  const ratios: number[] = [];
  for (const entry of list) {
    const mine = read(entry.record, entry.submissionSide);
    const theirs = read(entry.record, otherSide(entry.submissionSide));
    if (mine === null || theirs === null || theirs === 0) continue;
    ratios.push(mine / theirs);
  }
  if (ratios.length === 0) {
    return {
      ok: false,
      reason: `${label} at most ${limit}: not checkable, 0 of ${list.length} battles reported ${label} on both sides`,
    };
  }
  const worst = Math.max(...ratios);
  return {
    ok: worst <= limit,
    reason: `${label} at most ${limit}: worst battle ${round2(worst)} over ${ratios.length} of ${list.length} comparable battles (${worst <= limit ? 'met' : 'not met'})`,
  };
}

/** Deterministic: the same battles always produce the same verdict and the same sentences. */
export function evaluateBountyCondition(
  condition: BountyCondition,
  list: readonly BountyBattle[],
): BountyConditionResult {
  const checks: Check[] = [];

  checks.push({
    ok: list.length >= condition.minBattles,
    reason: `minBattles ${condition.minBattles}: ${list.length} linked battle(s) (${list.length >= condition.minBattles ? 'met' : 'not met'})`,
  });

  const decided = list.filter(
    (entry) => entry.record.verdict?.winner === 'a' || entry.record.verdict?.winner === 'b',
  );
  const won = decided.filter((entry) => entry.record.verdict?.winner === entry.submissionSide);
  if (condition.mustWin === 'every') {
    const ok = list.length > 0 && won.length === list.length;
    checks.push({
      ok,
      reason: `mustWin every: the submission won ${won.length} of ${list.length} battle(s), ${decided.length} decided (${ok ? 'met' : 'not met'})`,
    });
  } else {
    const ok = decided.length > 0 && won.length * 2 > decided.length;
    checks.push({
      ok,
      reason: `mustWin majority: the submission won ${won.length} of ${decided.length} decided battle(s) (${ok ? 'met' : 'not met'})`,
    });
  }

  if (condition.maxTokensRatio !== undefined) {
    checks.push(
      ratioCheck('tokens ratio', condition.maxTokensRatio, list, (record, side) =>
        metricValue(record, side, 'tokens_total'),
      ),
    );
  }
  if (condition.maxCostRatio !== undefined) {
    checks.push(
      ratioCheck('cost ratio', condition.maxCostRatio, list, (record, side) =>
        metricValue(record, side, 'cost_usd'),
      ),
    );
  }
  if (condition.maxDurationRatio !== undefined) {
    checks.push(ratioCheck('duration ratio', condition.maxDurationRatio, list, durationValue));
  }

  return {
    met: checks.every((check) => check.ok),
    battles: list.length,
    reasons: checks.map((check) => check.reason),
  };
}

// ---- rows <-> protocol ----------------------------------------------------------------------------

async function userLookup(
  db: ArenaDatabase,
  ids: readonly (string | null)[],
): Promise<Map<string, { id: string; login: string }>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  const lookup = new Map<string, { id: string; login: string }>();
  if (wanted.length === 0) return lookup;
  const rows = await db
    .select({ id: users.id, login: users.login })
    .from(users)
    .where(inArray(users.id, wanted));
  for (const row of rows) lookup.set(row.id, row);
  return lookup;
}

function toBounty(
  row: BountyRow,
  submissionCount: number,
  lookup: ReadonlyMap<string, { id: string; login: string }>,
): Bounty {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdBy: row.createdByUserId ? (lookup.get(row.createdByUserId) ?? null) : null,
    baseline: row.baseline,
    agent: row.agent,
    target: row.target,
    condition: row.condition,
    reward: { kind: row.rewardKind, description: row.rewardDescription },
    eligibility: row.eligibility,
    deadline: row.deadline ? row.deadline.toISOString() : null,
    submissionCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSubmission(
  row: BountySubmissionRow,
  battleIds: readonly string[],
  lookup: ReadonlyMap<string, { id: string; login: string }>,
): BountySubmission {
  return {
    id: row.id,
    bountyId: row.bountyId,
    submittedBy: row.submittedByUserId ? (lookup.get(row.submittedByUserId) ?? null) : null,
    harness: row.harness,
    battleIds: [...battleIds],
    result: row.result,
    createdAt: row.createdAt.toISOString(),
  };
}

async function submissionBattleIds(
  db: ArenaDatabase,
  submissionIds: readonly string[],
): Promise<Map<string, string[]>> {
  const bySubmission = new Map<string, string[]>();
  for (const id of submissionIds) bySubmission.set(id, []);
  if (submissionIds.length === 0) return bySubmission;
  const rows = await db
    .select({ battleId: battleLinks.battleId, targetId: battleLinks.targetId })
    .from(battleLinks)
    .where(and(eq(battleLinks.kind, 'bounty_submission'), inArray(battleLinks.targetId, [...submissionIds])))
    .orderBy(battleLinks.createdAt);
  for (const row of rows) bySubmission.get(row.targetId)?.push(row.battleId);
  return bySubmission;
}

// ---- creation and reads ---------------------------------------------------------------------------

export interface BountyActor {
  createdByUserId: string | null;
}

export async function createBounty(
  db: ArenaDatabase,
  req: CreateBountyRequest,
  actor: BountyActor,
): Promise<Bounty> {
  const [baselineRow] = await db
    .select({ id: harnesses.id })
    .from(harnesses)
    .where(eq(harnesses.slug, slugForCompetitor(req.baseline)))
    .limit(1);
  let benchmarkVersionId: string | null = null;
  if (req.target.kind === 'benchmark') {
    const [version] = await db
      .select({ id: benchmarkVersions.id })
      .from(benchmarkVersions)
      .where(eq(benchmarkVersions.id, req.target.versionId))
      .limit(1);
    benchmarkVersionId = version?.id ?? null;
  }
  const deadline = req.deadline ? new Date(req.deadline) : null;

  const [row] = await db
    .insert(bounties)
    .values({
      id: makeId('bounty'),
      title: req.title,
      description: req.description ?? null,
      status: 'open',
      createdByUserId: actor.createdByUserId,
      baseline: req.baseline,
      baselineHarnessId: baselineRow?.id ?? null,
      agent: req.agent,
      target: req.target,
      benchmarkVersionId,
      condition: req.condition,
      rewardKind: req.reward.kind,
      rewardDescription: req.reward.description,
      eligibility: req.eligibility ?? null,
      deadline: deadline && !Number.isNaN(deadline.getTime()) ? deadline : null,
    })
    .returning();
  if (!row) throw new Error('createBounty: the insert returned no row');
  const lookup = await userLookup(db, [row.createdByUserId]);
  return toBounty(row, 0, lookup);
}

async function countSubmissions(db: ArenaDatabase, bountyId: string): Promise<number> {
  const rows = await db
    .select({ id: bountySubmissions.id })
    .from(bountySubmissions)
    .where(eq(bountySubmissions.bountyId, bountyId));
  return rows.length;
}

export async function getBounty(db: ArenaDatabase, id: string): Promise<Bounty | null> {
  const [row] = await db.select().from(bounties).where(eq(bounties.id, id)).limit(1);
  if (!row) return null;
  const lookup = await userLookup(db, [row.createdByUserId]);
  return toBounty(row, await countSubmissions(db, id), lookup);
}

export interface ListBountiesOptions {
  status?: BountyStatus;
  limit?: number;
}

export async function listBounties(db: ArenaDatabase, opts: ListBountiesOptions = {}): Promise<Bounty[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? BOUNTY_LIST_LIMIT), BOUNTY_LIST_MAX);
  const filters = opts.status ? [eq(bounties.status, opts.status)] : [];
  const rows = await db
    .select()
    .from(bounties)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(bounties.createdAt))
    .limit(limit);
  const lookup = await userLookup(
    db,
    rows.map((row) => row.createdByUserId),
  );
  const counts = new Map<string, number>();
  if (rows.length > 0) {
    const submissionRows = await db
      .select({ bountyId: bountySubmissions.bountyId })
      .from(bountySubmissions)
      .where(
        inArray(
          bountySubmissions.bountyId,
          rows.map((row) => row.id),
        ),
      );
    for (const row of submissionRows) counts.set(row.bountyId, (counts.get(row.bountyId) ?? 0) + 1);
  }
  return rows.map((row) => toBounty(row, counts.get(row.id) ?? 0, lookup));
}

export async function listBountySubmissions(
  db: ArenaDatabase,
  bountyId: string,
): Promise<BountySubmission[]> {
  const rows = await db
    .select()
    .from(bountySubmissions)
    .where(eq(bountySubmissions.bountyId, bountyId))
    .orderBy(desc(bountySubmissions.createdAt));
  const [lookup, battleIds] = await Promise.all([
    userLookup(
      db,
      rows.map((row) => row.submittedByUserId),
    ),
    submissionBattleIds(
      db,
      rows.map((row) => row.id),
    ),
  ]);
  return rows.map((row) => toSubmission(row, battleIds.get(row.id) ?? [], lookup));
}

export async function getBountySubmission(
  db: ArenaDatabase,
  submissionId: string,
): Promise<BountySubmission | null> {
  const [row] = await db
    .select()
    .from(bountySubmissions)
    .where(eq(bountySubmissions.id, submissionId))
    .limit(1);
  if (!row) return null;
  const [lookup, battleIds] = await Promise.all([
    userLookup(db, [row.submittedByUserId]),
    submissionBattleIds(db, [row.id]),
  ]);
  return toSubmission(row, battleIds.get(row.id) ?? [], lookup);
}

export type BountyOutcome<T> =
  { ok: true; value: T } | { ok: false; code: 'not_found' | 'forbidden' | 'conflict'; reason: string };

export interface SubmitToBountyRequest {
  harness: CompetitorRef;
}

/** Register an intent to compete. The battles are run locally afterwards and uploaded against this id. */
export async function submitToBounty(
  db: ArenaDatabase,
  bountyId: string,
  req: SubmitToBountyRequest,
  actor: { userId: string | null },
): Promise<BountyOutcome<BountySubmission>> {
  const [bounty] = await db.select().from(bounties).where(eq(bounties.id, bountyId)).limit(1);
  if (!bounty) return { ok: false, code: 'not_found', reason: 'no bounty with that id' };
  if (bounty.status !== 'open') {
    return { ok: false, code: 'conflict', reason: `this bounty is ${bounty.status}, not open` };
  }
  const [harnessRow] = await db
    .select({ id: harnesses.id })
    .from(harnesses)
    .where(eq(harnesses.slug, slugForCompetitor(req.harness)))
    .limit(1);
  const [row] = await db
    .insert(bountySubmissions)
    .values({
      id: makeId('bountySubmission'),
      bountyId,
      submittedByUserId: actor.userId,
      harness: req.harness,
      harnessId: harnessRow?.id ?? null,
      result: null,
    })
    .returning();
  if (!row) throw new Error('submitToBounty: the insert returned no row');
  const lookup = await userLookup(db, [row.submittedByUserId]);
  return { ok: true, value: toSubmission(row, [], lookup) };
}

/**
 * Recompute a submission's result from the battles linked to it. Called by links.ts after a battle is
 * attached, and by the API whenever the submission is read, so a stored result is never stale.
 */
export async function evaluateSubmission(
  db: ArenaDatabase,
  submissionId: string,
): Promise<BountySubmission | null> {
  const [submission] = await db
    .select()
    .from(bountySubmissions)
    .where(eq(bountySubmissions.id, submissionId))
    .limit(1);
  if (!submission) return null;
  const [bounty] = await db.select().from(bounties).where(eq(bounties.id, submission.bountyId)).limit(1);
  if (!bounty) return null;

  const links = await db
    .select({ battleId: battleLinks.battleId })
    .from(battleLinks)
    .where(and(eq(battleLinks.kind, 'bounty_submission'), eq(battleLinks.targetId, submissionId)))
    .orderBy(battleLinks.createdAt);
  const battleIds = links.map((link) => link.battleId);

  const list: BountyBattle[] = [];
  if (battleIds.length > 0) {
    const rows = await db
      .select({ id: battles.id, record: battles.record })
      .from(battles)
      .where(inArray(battles.id, battleIds));
    const byId = new Map(rows.map((row) => [row.id, row.record]));
    for (const id of battleIds) {
      const record = byId.get(id);
      if (!record) continue;
      list.push({ record, submissionSide: submissionSideFor(record, submission.harness) });
    }
  }

  const result = evaluateBountyCondition(bounty.condition, list);
  await db
    .update(bountySubmissions)
    .set({ result, updatedAt: new Date() })
    .where(eq(bountySubmissions.id, submissionId));
  const lookup = await userLookup(db, [submission.submittedByUserId]);
  return toSubmission({ ...submission, result }, battleIds, lookup);
}

/** Which side of a battle the submission's harness ran on. Defaults to B, the challenger's slot. */
export function submissionSideFor(record: BattleRecord, harness: CompetitorRef): Side {
  const wanted = refFromCompetitor(harness);
  if (sameHarness(refFromRun(record.runs.a.harness), wanted)) return 'a';
  return 'b';
}

export async function closeBounty(
  db: ArenaDatabase,
  id: string,
  userId: string,
): Promise<BountyOutcome<Bounty>> {
  const [row] = await db.select().from(bounties).where(eq(bounties.id, id)).limit(1);
  if (!row) return { ok: false, code: 'not_found', reason: 'no bounty with that id' };
  if (row.createdByUserId !== userId) {
    return { ok: false, code: 'forbidden', reason: 'only the person who posted a bounty can close it' };
  }
  if (row.status !== 'open') {
    return { ok: false, code: 'conflict', reason: `this bounty is already ${row.status}` };
  }
  await db.update(bounties).set({ status: 'closed', updatedAt: new Date() }).where(eq(bounties.id, id));
  const closed = await getBounty(db, id);
  if (!closed) return { ok: false, code: 'not_found', reason: 'no bounty with that id' };
  return { ok: true, value: closed };
}

export interface AwardedBounty {
  bounty: Bounty;
  submission: BountySubmission;
}

/**
 * Award a bounty to one submission. The condition is recomputed first, so a bounty can only be awarded
 * to a submission whose linked battles actually meet it. Arena transfers nothing: `reward.kind` says
 * whether this is reputation or something the poster settles elsewhere.
 */
export async function awardBounty(
  db: ArenaDatabase,
  id: string,
  submissionId: string,
  userId: string,
): Promise<BountyOutcome<AwardedBounty>> {
  const [row] = await db.select().from(bounties).where(eq(bounties.id, id)).limit(1);
  if (!row) return { ok: false, code: 'not_found', reason: 'no bounty with that id' };
  if (row.createdByUserId !== userId) {
    return { ok: false, code: 'forbidden', reason: 'only the person who posted a bounty can award it' };
  }
  if (row.status === 'awarded') {
    return { ok: false, code: 'conflict', reason: 'this bounty was already awarded' };
  }
  const submission = await evaluateSubmission(db, submissionId);
  if (!submission || submission.bountyId !== id) {
    return { ok: false, code: 'not_found', reason: 'that submission does not belong to this bounty' };
  }
  if (!submission.result?.met) {
    return {
      ok: false,
      code: 'conflict',
      reason: `that submission does not meet the condition yet: ${(submission.result?.reasons ?? []).join('; ') || 'no battles linked'}`,
    };
  }
  await db.update(bounties).set({ status: 'awarded', updatedAt: new Date() }).where(eq(bounties.id, id));
  const awarded = await getBounty(db, id);
  if (!awarded) return { ok: false, code: 'not_found', reason: 'no bounty with that id' };
  return { ok: true, value: { bounty: awarded, submission } };
}
