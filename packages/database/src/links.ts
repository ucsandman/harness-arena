import { and, eq, isNull } from 'drizzle-orm';
import type { BattleRecord, CompetitorRef, Side } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import type { BattleLinkRow } from './schema/index.js';
import {
  battleLinks,
  bounties,
  bountySubmissions,
  challenges,
  experiments,
  harnessVersions,
} from './schema/index.js';
import { refFromCompetitor, refFromRun, sameHarness } from './arena-refs.js';
import { completeChallenge } from './challenges.js';
import { getMatchContext, settleMatch } from './tournaments.js';
import { evaluateSubmission, submissionSideFor } from './bounties.js';
import { recordLineage, lineageFromManifest } from './lineage.js';
import { upsertComponentsFromManifest } from './components.js';

export {
  normalizeSource,
  refFromCompetitor,
  refFromRun,
  sameHarness,
  slugForCompetitor,
  slugForHarnessRef,
  slugForSourceUrl,
} from './arena-refs.js';

/**
 * Attaching an uploaded battle to the competitive object it claims to serve.
 *
 * The CLI puts ids in `spec.arena`; a client can put anything there. Nothing is taken on trust: before
 * a link row exists, the battle's own runs must show the harnesses and the agent that the challenge,
 * match or bounty actually names. A battle that does not match is refused with a reason, and the
 * battle itself is still stored — it simply does not count towards that object.
 *
 * `battle_links` has (battle, kind) as its primary key, so re-uploading the same battle converges.
 */

export type BattleLinkKind = 'challenge' | 'experiment' | 'tournament_match' | 'bounty_submission';

export interface LinkOutcome {
  linked: Array<{ kind: BattleLinkKind; targetId: string }>;
  refused: Array<{ kind: BattleLinkKind; targetId: string; reason: string }>;
}

export interface LinkOptions {
  /** the account that uploaded the battle; used where an object is owned by a person */
  ownerUserId: string | null;
}

function agentMatches(record: BattleRecord, agentId: string): boolean {
  return record.runs.a.agent.id === agentId && record.runs.b.agent.id === agentId;
}

/** The battle ran these two harnesses, in either slot order. */
function matchesEitherWay(record: BattleRecord, a: CompetitorRef, b: CompetitorRef): boolean {
  const runA = refFromRun(record.runs.a.harness);
  const runB = refFromRun(record.runs.b.harness);
  const wantA = refFromCompetitor(a);
  const wantB = refFromCompetitor(b);
  const straight = sameHarness(runA, wantA) && sameHarness(runB, wantB);
  const swapped = sameHarness(runA, wantB) && sameHarness(runB, wantA);
  return straight || swapped;
}

function decided(record: BattleRecord): boolean {
  const winner = record.verdict?.winner;
  return record.status === 'completed' && (winner === 'a' || winner === 'b');
}

async function insertLink(
  db: ArenaDatabase,
  battleId: string,
  kind: BattleLinkKind,
  targetId: string,
  treatmentSide: Side | null = null,
): Promise<void> {
  await db
    .insert(battleLinks)
    .values({ battleId, kind, targetId, treatmentSide })
    .onConflictDoUpdate({
      target: [battleLinks.battleId, battleLinks.kind],
      set: { targetId, treatmentSide },
    });
}

export async function battleLinksFor(db: ArenaDatabase, battleId: string): Promise<BattleLinkRow[]> {
  return db.select().from(battleLinks).where(eq(battleLinks.battleId, battleId)).orderBy(battleLinks.kind);
}

/** Every battle linked to one arena object, oldest first. */
export async function battlesLinkedTo(
  db: ArenaDatabase,
  kind: BattleLinkKind,
  targetId: string,
): Promise<string[]> {
  const rows = await db
    .select({ battleId: battleLinks.battleId })
    .from(battleLinks)
    .where(and(eq(battleLinks.kind, kind), eq(battleLinks.targetId, targetId)))
    .orderBy(battleLinks.createdAt);
  return rows.map((row) => row.battleId);
}

// ---- per-kind verification -----------------------------------------------------------------------

async function linkChallenge(
  db: ArenaDatabase,
  record: BattleRecord,
  challengeId: string,
  opts: LinkOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await db.select().from(challenges).where(eq(challenges.id, challengeId)).limit(1);
  if (!row) return { ok: false, reason: 'no challenge with that id' };
  if (row.status === 'cancelled' || row.status === 'expired') {
    return { ok: false, reason: `that challenge is ${row.status}` };
  }
  if (
    row.acceptedByUserId &&
    opts.ownerUserId !== row.acceptedByUserId &&
    opts.ownerUserId !== row.createdByUserId
  ) {
    return { ok: false, reason: 'that challenge was accepted by another account' };
  }
  if (!agentMatches(record, row.agent.id)) {
    return {
      ok: false,
      reason: `the challenge is for agent ${row.agent.id}; this battle ran ${record.runs.a.agent.id} against ${record.runs.b.agent.id}`,
    };
  }
  if (!matchesEitherWay(record, row.sideA, row.sideB)) {
    return { ok: false, reason: 'this battle did not run the two harnesses the challenge names' };
  }
  await insertLink(db, record.id, 'challenge', challengeId);
  if (decided(record)) await completeChallenge(db, challengeId);
  return { ok: true };
}

async function linkTournamentMatch(
  db: ArenaDatabase,
  record: BattleRecord,
  matchId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const context = await getMatchContext(db, matchId);
  if (!context) return { ok: false, reason: 'no tournament match with that id' };
  const { tournament, entrantA, entrantB } = context;
  if (tournament.status === 'cancelled') return { ok: false, reason: 'that tournament was cancelled' };
  if (!entrantA || !entrantB) {
    return { ok: false, reason: 'that match is still waiting for an entrant from a previous round' };
  }
  if (!agentMatches(record, tournament.agent.id)) {
    return {
      ok: false,
      reason: `the tournament is for agent ${tournament.agent.id}; this battle ran ${record.runs.a.agent.id} against ${record.runs.b.agent.id}`,
    };
  }
  // a match is slot-exact: entrant A must have run as side A, or the bracket would record the wrong winner
  const slotA = sameHarness(refFromRun(record.runs.a.harness), {
    source: entrantA.harness.source,
    commit: entrantA.harness.commit ?? null,
  });
  const slotB = sameHarness(refFromRun(record.runs.b.harness), {
    source: entrantB.harness.source,
    commit: entrantB.harness.commit ?? null,
  });
  if (!slotA || !slotB) {
    return {
      ok: false,
      reason: `this battle did not run ${entrantA.label} as side A against ${entrantB.label} as side B`,
    };
  }
  await insertLink(db, record.id, 'tournament_match', matchId);
  if (record.status === 'completed') await settleMatch(db, matchId, record);
  return { ok: true };
}

async function linkBountySubmission(
  db: ArenaDatabase,
  record: BattleRecord,
  submissionId: string,
  opts: LinkOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [submission] = await db
    .select()
    .from(bountySubmissions)
    .where(eq(bountySubmissions.id, submissionId))
    .limit(1);
  if (!submission) return { ok: false, reason: 'no bounty submission with that id' };
  const [bounty] = await db.select().from(bounties).where(eq(bounties.id, submission.bountyId)).limit(1);
  if (!bounty) return { ok: false, reason: 'that submission belongs to no bounty' };
  if (submission.submittedByUserId && opts.ownerUserId !== submission.submittedByUserId) {
    return { ok: false, reason: 'that submission belongs to another account' };
  }
  if (bounty.status === 'cancelled' || bounty.status === 'expired') {
    return { ok: false, reason: `that bounty is ${bounty.status}` };
  }
  if (!agentMatches(record, bounty.agent.id)) {
    return {
      ok: false,
      reason: `the bounty is for agent ${bounty.agent.id}; this battle ran ${record.runs.a.agent.id} against ${record.runs.b.agent.id}`,
    };
  }
  if (!matchesEitherWay(record, submission.harness, bounty.baseline)) {
    return { ok: false, reason: 'this battle did not run the submitted harness against the bounty baseline' };
  }
  await insertLink(
    db,
    record.id,
    'bounty_submission',
    submissionId,
    submissionSideFor(record, submission.harness),
  );
  await evaluateSubmission(db, submissionId);
  return { ok: true };
}

/**
 * The experiment workstream owns `linkBattleToExperiment`. It is resolved at call time rather than
 * imported statically so this module builds and runs whether or not that function has landed yet, and
 * so the two modules can reference each other without a load-order cycle.
 */
type LinkExperimentFn = (
  db: ArenaDatabase,
  experimentId: string,
  battleId: string,
  treatmentSide: Side,
) => Promise<unknown>;

async function resolveExperimentLinker(): Promise<LinkExperimentFn | null> {
  const mod = (await import('./experiments.js')) as unknown as {
    linkBattleToExperiment?: LinkExperimentFn;
  };
  return typeof mod.linkBattleToExperiment === 'function' ? mod.linkBattleToExperiment : null;
}

async function linkExperiment(
  db: ArenaDatabase,
  record: BattleRecord,
  experimentId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await db.select().from(experiments).where(eq(experiments.id, experimentId)).limit(1);
  if (!row) return { ok: false, reason: 'no experiment with that id' };
  if (!agentMatches(record, row.agent.id)) {
    return {
      ok: false,
      reason: `the experiment is for agent ${row.agent.id}; this battle ran ${record.runs.a.agent.id} against ${record.runs.b.agent.id}`,
    };
  }
  if (!matchesEitherWay(record, row.control, row.treatment)) {
    return { ok: false, reason: 'this battle did not run the experiment control against its treatment' };
  }
  // control is side A by convention (docs/CHALLENGES.md); the record decides when it was swapped
  const treatmentSide: Side = sameHarness(refFromRun(record.runs.a.harness), refFromCompetitor(row.treatment))
    ? 'a'
    : 'b';
  await insertLink(db, record.id, 'experiment', experimentId, treatmentSide);
  const linker = await resolveExperimentLinker();
  if (linker) await linker(db, experimentId, record.id, treatmentSide);
  return { ok: true };
}

/**
 * Read `spec.arena` and attach the battle to every object it names that it genuinely matches.
 * Returns what was linked and, for everything else, why not.
 */
export async function linkBattleToArena(
  db: ArenaDatabase,
  record: BattleRecord,
  opts: LinkOptions,
): Promise<LinkOutcome> {
  const outcome: LinkOutcome = { linked: [], refused: [] };
  const arena = record.spec.arena;
  if (!arena) return outcome;

  const attempts: Array<{
    kind: BattleLinkKind;
    targetId: string;
    run: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  }> = [];
  if (arena.challengeId) {
    const id = arena.challengeId;
    attempts.push({ kind: 'challenge', targetId: id, run: () => linkChallenge(db, record, id, opts) });
  }
  if (arena.tournamentMatchId) {
    const id = arena.tournamentMatchId;
    attempts.push({ kind: 'tournament_match', targetId: id, run: () => linkTournamentMatch(db, record, id) });
  }
  if (arena.bountySubmissionId) {
    const id = arena.bountySubmissionId;
    attempts.push({
      kind: 'bounty_submission',
      targetId: id,
      run: () => linkBountySubmission(db, record, id, opts),
    });
  }
  if (arena.experimentId) {
    const id = arena.experimentId;
    attempts.push({ kind: 'experiment', targetId: id, run: () => linkExperiment(db, record, id) });
  }

  for (const attempt of attempts) {
    const result = await attempt.run();
    if (result.ok) outcome.linked.push({ kind: attempt.kind, targetId: attempt.targetId });
    else outcome.refused.push({ kind: attempt.kind, targetId: attempt.targetId, reason: result.reason });
  }
  return outcome;
}

// ---- the upload hook -----------------------------------------------------------------------------

export interface BattleSideIds {
  harnessId: string;
  /** the `harness_versions` row; looked up from the record's commit when the caller does not have it */
  versionId?: string | null;
}

export interface AfterBattleUpsertResult {
  lineage: { a: number; b: number };
  components: { a: number; b: number };
  links: LinkOutcome;
}

async function versionIdFor(
  db: ArenaDatabase,
  harnessId: string,
  commit: string | null,
): Promise<string | null> {
  const commitFilter = commit === null ? isNull(harnessVersions.commit) : eq(harnessVersions.commit, commit);
  const [row] = await db
    .select({ id: harnessVersions.id })
    .from(harnessVersions)
    .where(and(eq(harnessVersions.harnessId, harnessId), commitFilter))
    .limit(1);
  if (row) return row.id;
  // a short commit in the record against a full sha in the catalogue (or the other way round)
  if (commit === null) return null;
  const rows = await db
    .select({ id: harnessVersions.id, commit: harnessVersions.commit })
    .from(harnessVersions)
    .where(eq(harnessVersions.harnessId, harnessId));
  const wanted = commit.toLowerCase();
  const found = rows.find((candidate) => {
    const value = (candidate.commit ?? '').toLowerCase();
    return value.length > 0 && (value.startsWith(wanted) || wanted.startsWith(value));
  });
  return found?.id ?? null;
}

/**
 * Everything the catalogue learns from one uploaded battle beyond the battle itself: the ancestry each
 * harness declares in its manifest, the components it declares, and the competitive objects the spec
 * claims. Call it straight after `upsertBattleFromRecord`; it never throws on a link refusal, because a
 * battle that fails verification is still a battle.
 */
export async function afterBattleUpsert(
  db: ArenaDatabase,
  record: BattleRecord,
  ids: { a: BattleSideIds; b: BattleSideIds },
  opts: LinkOptions = { ownerUserId: null },
): Promise<AfterBattleUpsertResult> {
  const lineage = { a: 0, b: 0 };
  const componentCounts = { a: 0, b: 0 };

  for (const side of ['a', 'b'] as const) {
    const run = record.runs[side];
    const manifest = run.harness.manifest;
    if (!manifest) continue;
    const harnessId = ids[side].harnessId;
    lineage[side] = await recordLineage(db, harnessId, lineageFromManifest(manifest));
    const versionId = ids[side].versionId ?? (await versionIdFor(db, harnessId, run.harness.commit));
    if (versionId) {
      componentCounts[side] = await upsertComponentsFromManifest(db, versionId, manifest);
    }
  }

  const links = await linkBattleToArena(db, record, opts);
  return { lineage, components: componentCounts, links };
}

/** Kept for callers that only want the "did this battle serve anything" answer. */
export function linkSummary(outcome: LinkOutcome): string {
  const parts: string[] = [];
  if (outcome.linked.length > 0) parts.push(`linked ${outcome.linked.map((l) => l.kind).join(', ')}`);
  for (const refusal of outcome.refused) parts.push(`${refusal.kind} refused: ${refusal.reason}`);
  return parts.join('; ');
}
