import { and, desc, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import type { Challenge, ChallengeStatus, CreateChallengeRequest } from '@harness-arena/protocol';
import { makeId } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import type { ChallengeRow } from './schema/index.js';
import { battleLinks, benchmarkVersions, challenges, harnesses, users } from './schema/index.js';
import { slugForCompetitor } from './arena-refs.js';

/**
 * Challenges: "my harness against yours, on this task".
 *
 * The server stores the definition and nothing else. Whoever accepts a challenge runs it on their own
 * machine with `arena challenge run <id>` and uploads the battle; links.ts then verifies that the
 * uploaded battle really ran the two harnesses the challenge names before attaching it. A completed
 * challenge is therefore a community result, exactly like any other uploaded battle.
 */

export const CHALLENGE_LIST_LIMIT = 50;
const CHALLENGE_LIST_MAX = 200;

export interface ChallengeActor {
  createdByUserId: string | null;
}

export type ChallengeOutcome =
  | { ok: true; challenge: Challenge }
  | { ok: false; reason: string; code: 'not_found' | 'forbidden' | 'conflict' };

/** The `{ id, login }` pairs a Challenge embeds, keyed by user id. */
export type UserLookup = ReadonlyMap<string, { id: string; login: string }>;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Row plus its linked battles, as the protocol Challenge. Pure: every lookup is already resolved. */
export function toChallenge(row: ChallengeRow, battleIds: readonly string[], lookup: UserLookup): Challenge {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdBy: row.createdByUserId ? (lookup.get(row.createdByUserId) ?? null) : null,
    sides: { a: row.sideA, b: row.sideB },
    agent: row.agent,
    target: row.target,
    privacy: row.privacy,
    visibility: row.visibility,
    ratingEligible: row.ratingEligible,
    battleIds: [...battleIds],
    acceptedBy: row.acceptedByUserId ? (lookup.get(row.acceptedByUserId) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: iso(row.expiresAt),
    completedAt: iso(row.completedAt),
  };
}

async function lookupUsers(db: ArenaDatabase, rows: readonly ChallengeRow[]): Promise<UserLookup> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.createdByUserId) ids.add(row.createdByUserId);
    if (row.acceptedByUserId) ids.add(row.acceptedByUserId);
  }
  const lookup = new Map<string, { id: string; login: string }>();
  if (ids.size === 0) return lookup;
  const found = await db
    .select({ id: users.id, login: users.login })
    .from(users)
    .where(inArray(users.id, [...ids]));
  for (const user of found) lookup.set(user.id, user);
  return lookup;
}

async function battleIdsFor(
  db: ArenaDatabase,
  challengeIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byChallenge = new Map<string, string[]>();
  for (const id of challengeIds) byChallenge.set(id, []);
  if (challengeIds.length === 0) return byChallenge;
  const rows = await db
    .select({ battleId: battleLinks.battleId, targetId: battleLinks.targetId })
    .from(battleLinks)
    .where(and(eq(battleLinks.kind, 'challenge'), inArray(battleLinks.targetId, [...challengeIds])))
    .orderBy(battleLinks.createdAt);
  for (const row of rows) byChallenge.get(row.targetId)?.push(row.battleId);
  return byChallenge;
}

async function hydrate(db: ArenaDatabase, rows: readonly ChallengeRow[]): Promise<Challenge[]> {
  const [lookup, battles] = await Promise.all([
    lookupUsers(db, rows),
    battleIdsFor(
      db,
      rows.map((row) => row.id),
    ),
  ]);
  return rows.map((row) => toChallenge(row, battles.get(row.id) ?? [], lookup));
}

/** The `harnesses` row for a competitor, when the catalogue already knows it. Never creates one. */
async function harnessIdForSlug(db: ArenaDatabase, slug: string): Promise<string | null> {
  const [row] = await db
    .select({ id: harnesses.id })
    .from(harnesses)
    .where(eq(harnesses.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

async function benchmarkVersionIdFor(db: ArenaDatabase, versionId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: benchmarkVersions.id })
    .from(benchmarkVersions)
    .where(eq(benchmarkVersions.id, versionId))
    .limit(1);
  return row?.id ?? null;
}

export async function createChallenge(
  db: ArenaDatabase,
  req: CreateChallengeRequest,
  actor: ChallengeActor,
): Promise<Challenge> {
  const [harnessAId, harnessBId] = await Promise.all([
    harnessIdForSlug(db, slugForCompetitor(req.sides.a)),
    harnessIdForSlug(db, slugForCompetitor(req.sides.b)),
  ]);
  const benchmarkVersionId =
    req.target.kind === 'benchmark' ? await benchmarkVersionIdFor(db, req.target.versionId) : null;
  const expiresAt = req.expiresAt ? new Date(req.expiresAt) : null;

  const [row] = await db
    .insert(challenges)
    .values({
      id: makeId('challenge'),
      title: req.title,
      description: req.description ?? null,
      status: 'open',
      createdByUserId: actor.createdByUserId,
      sideA: req.sides.a,
      sideB: req.sides.b,
      harnessAId,
      harnessBId,
      agent: req.agent,
      target: req.target,
      benchmarkVersionId,
      privacy: req.privacy,
      visibility: req.visibility,
      ratingEligible: req.ratingEligible,
      expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    })
    .returning();
  if (!row) throw new Error('createChallenge: the insert returned no row');
  const [challenge] = await hydrate(db, [row]);
  if (!challenge) throw new Error('createChallenge: could not hydrate the new challenge');
  return challenge;
}

async function rowById(db: ArenaDatabase, id: string): Promise<ChallengeRow | null> {
  const [row] = await db.select().from(challenges).where(eq(challenges.id, id)).limit(1);
  return row ?? null;
}

/** A private challenge is visible only to the person who created it and the person who accepted it. */
export function challengeVisibleTo(row: ChallengeRow, viewerUserId: string | null): boolean {
  if (row.visibility !== 'private') return true;
  if (!viewerUserId) return false;
  return row.createdByUserId === viewerUserId || row.acceptedByUserId === viewerUserId;
}

export async function getChallenge(
  db: ArenaDatabase,
  id: string,
  viewerUserId: string | null = null,
): Promise<Challenge | null> {
  const row = await rowById(db, id);
  if (!row) return null;
  if (!challengeVisibleTo(row, viewerUserId)) return null;
  const [challenge] = await hydrate(db, [row]);
  return challenge ?? null;
}

export interface ListChallengesOptions {
  status?: ChallengeStatus;
  /** only challenges whose side A or side B resolved to this catalogue slug */
  harnessSlug?: string;
  limit?: number;
}

/**
 * Public challenges, newest first. Unlisted and private ones are reachable by id only, which is what
 * those visibilities mean everywhere else in Arena.
 */
export async function listChallenges(
  db: ArenaDatabase,
  opts: ListChallengesOptions = {},
): Promise<Challenge[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? CHALLENGE_LIST_LIMIT), CHALLENGE_LIST_MAX);
  const filters = [eq(challenges.visibility, 'public')];
  if (opts.status) filters.push(eq(challenges.status, opts.status));
  if (opts.harnessSlug) {
    const harnessId = await harnessIdForSlug(db, opts.harnessSlug);
    // an unknown slug matches nothing rather than everything
    if (!harnessId) return [];
    const either = or(eq(challenges.harnessAId, harnessId), eq(challenges.harnessBId, harnessId));
    if (either) filters.push(either);
  }
  const rows = await db
    .select()
    .from(challenges)
    .where(and(...filters))
    .orderBy(desc(challenges.createdAt))
    .limit(limit);
  return hydrate(db, rows);
}

/**
 * Take a challenge on. The creator may accept their own: running both sides yourself is the honest
 * default when nobody else has the hardware, and the battle is labelled community either way.
 */
export async function acceptChallenge(
  db: ArenaDatabase,
  id: string,
  userId: string,
): Promise<ChallengeOutcome> {
  const row = await rowById(db, id);
  if (!row) return { ok: false, code: 'not_found', reason: 'no challenge with that id' };
  if (row.status === 'accepted' && row.acceptedByUserId === userId) {
    const current = await getChallenge(db, id, userId);
    if (!current) return { ok: false, code: 'not_found', reason: 'no challenge with that id' };
    return { ok: true, challenge: current };
  }
  if (row.status !== 'open') {
    return { ok: false, code: 'conflict', reason: `this challenge is ${row.status}, not open` };
  }
  await db
    .update(challenges)
    .set({ status: 'accepted', acceptedByUserId: userId, updatedAt: new Date() })
    .where(and(eq(challenges.id, id), eq(challenges.status, 'open')));
  const updated = await getChallenge(db, id, userId);
  if (!updated) return { ok: false, code: 'not_found', reason: 'no challenge with that id' };
  return { ok: true, challenge: updated };
}

/**
 * Called by links.ts once an uploaded battle that belongs to this challenge is completed and carries a
 * decided verdict. Idempotent: a second linked battle does not move the timestamp.
 */
export async function completeChallenge(
  db: ArenaDatabase,
  id: string,
  at: Date = new Date(),
): Promise<Challenge | null> {
  const row = await rowById(db, id);
  if (!row) return null;
  if (row.status === 'open' || row.status === 'accepted') {
    await db
      .update(challenges)
      .set({ status: 'completed', completedAt: at, updatedAt: at })
      .where(eq(challenges.id, id));
  }
  const [fresh] = await db.select().from(challenges).where(eq(challenges.id, id)).limit(1);
  if (!fresh) return null;
  const [challenge] = await hydrate(db, [fresh]);
  return challenge ?? null;
}

/** Only the creator can withdraw a challenge, and only before it completed. */
export async function cancelChallenge(
  db: ArenaDatabase,
  id: string,
  userId: string,
): Promise<ChallengeOutcome> {
  const row = await rowById(db, id);
  if (!row) return { ok: false, code: 'not_found', reason: 'no challenge with that id' };
  if (row.createdByUserId !== userId) {
    return { ok: false, code: 'forbidden', reason: 'only the person who created a challenge can cancel it' };
  }
  if (row.status === 'completed') {
    return { ok: false, code: 'conflict', reason: 'this challenge already completed' };
  }
  const now = new Date();
  await db.update(challenges).set({ status: 'cancelled', updatedAt: now }).where(eq(challenges.id, id));
  const updated = await getChallenge(db, id, userId);
  if (!updated) return { ok: false, code: 'not_found', reason: 'no challenge with that id' };
  return { ok: true, challenge: updated };
}

/** Moves every open or accepted challenge whose deadline has passed to `expired`. Returns the count. */
export async function expireChallenges(db: ArenaDatabase, now: Date = new Date()): Promise<number> {
  const open = or(eq(challenges.status, 'open'), eq(challenges.status, 'accepted'));
  const rows = await db
    .update(challenges)
    .set({ status: 'expired', updatedAt: now })
    .where(and(isNotNull(challenges.expiresAt), lte(challenges.expiresAt, now), ...(open ? [open] : [])))
    .returning({ id: challenges.id });
  return rows.length;
}
