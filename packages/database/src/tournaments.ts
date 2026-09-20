import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type {
  BattleRecord,
  CreateTournamentRequest,
  Tournament,
  TournamentEntrant,
  TournamentListItem,
  TournamentMatch,
  TournamentStatus,
} from '@harness-arena/protocol';
import { RATING_DEFAULT, makeId } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import type { TournamentMatchRow, TournamentRow } from './schema/index.js';
import {
  battleLinks,
  benchmarkVersions,
  harnesses,
  ratings,
  tournamentMatches,
  tournaments,
  users,
} from './schema/index.js';
import { slugForCompetitor } from './arena-refs.js';

/**
 * Single-elimination tournaments.
 *
 * Arena runs no match. `createTournament` seeds the bracket from the community ratings the entrants
 * already hold and writes every match slot up front; `arena tournament play <id>` runs the pending
 * matches on a contributor's machine and uploads them, and links.ts calls `settleMatch` once a battle
 * is verified against the slot it claims. A tie or an inconclusive verdict never invents a winner: the
 * higher seed advances and the match says `settledBy: 'seed'` so a reader can see it.
 */

export const TOURNAMENT_LIST_LIMIT = 50;
const TOURNAMENT_LIST_MAX = 200;

// ---- pure bracket maths -------------------------------------------------------------------------

export interface BracketMatch {
  round: number;
  position: number;
  /** 1-based SEED, not an entrant index; null means the slot waits on the previous round */
  a: number | null;
  b: number | null;
  /** the seed in `a` has no opponent and advances without a battle */
  bye: boolean;
}

/** The next power of two at or above n, never below 2. */
export function bracketSize(entrants: number): number {
  let size = 2;
  while (size < entrants) size *= 2;
  return size;
}

/**
 * Standard (recursive) seeding order for a full bracket: [1, N, 4, N-3, 2, N-1, 3, N-2] for N = 8.
 * Reading it in pairs gives the first-round matches 1 vs N, 2 vs N-1, 3 vs N-2 ... and places them so
 * the two best seeds can only meet in the final. Even indexes always hold the better seed, which is
 * why a bye always lands in slot `a`.
 */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const paired = order.length * 2;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed);
      next.push(paired + 1 - seed);
    }
    order = next;
  }
  return order;
}

/**
 * Every match of a single-elimination bracket for `n` entrants, in seed terms. Round 0 holds
 * `size / 2` matches; a seed above `n` does not exist, so its opponent takes a bye. Later rounds carry
 * null slots that settleMatch fills as the previous round settles.
 */
export function buildBracket(n: number): BracketMatch[] {
  if (!Number.isInteger(n) || n < 2) throw new Error(`a bracket needs at least 2 entrants, got ${n}`);
  const size = bracketSize(n);
  const order = seedOrder(size);
  const matches: BracketMatch[] = [];

  for (let position = 0; position < size / 2; position++) {
    const a = order[position * 2] as number;
    const b = order[position * 2 + 1] as number;
    const opponentExists = b <= n;
    matches.push({
      round: 0,
      position,
      a,
      b: opponentExists ? b : null,
      bye: !opponentExists,
    });
  }

  let count = size / 2;
  let round = 1;
  while (count > 1) {
    count = count / 2;
    for (let position = 0; position < count; position++) {
      matches.push({ round, position, a: null, b: null, bye: false });
    }
    round += 1;
  }
  return matches;
}

/** Where the winner of (round, position) goes: two matches feed one, even positions into slot a. */
export function nextSlot(
  round: number,
  position: number,
): { round: number; position: number; slot: 'a' | 'b' } {
  return { round: round + 1, position: position >> 1, slot: position % 2 === 0 ? 'a' : 'b' };
}

/** How many rounds a bracket of `n` entrants has. */
export function bracketRounds(n: number): number {
  return Math.log2(bracketSize(n));
}

// ---- rows <-> protocol --------------------------------------------------------------------------

function toMatch(row: TournamentMatchRow, battleIds: readonly string[]): TournamentMatch {
  return {
    id: row.id,
    round: row.round,
    position: row.position,
    a: row.entrantA,
    b: row.entrantB,
    bye: row.bye,
    battleIds: [...battleIds],
    winner: row.winner,
    settledBy: row.settledBy,
  };
}

async function matchBattleIds(
  db: ArenaDatabase,
  matchIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byMatch = new Map<string, string[]>();
  for (const id of matchIds) byMatch.set(id, []);
  if (matchIds.length === 0) return byMatch;
  const rows = await db
    .select({ battleId: battleLinks.battleId, targetId: battleLinks.targetId })
    .from(battleLinks)
    .where(and(eq(battleLinks.kind, 'tournament_match'), inArray(battleLinks.targetId, [...matchIds])))
    .orderBy(battleLinks.createdAt);
  for (const row of rows) byMatch.get(row.targetId)?.push(row.battleId);
  return byMatch;
}

async function creatorOf(
  db: ArenaDatabase,
  userId: string | null,
): Promise<{ id: string; login: string } | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ id: users.id, login: users.login })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

async function toTournament(db: ArenaDatabase, row: TournamentRow): Promise<Tournament> {
  const matchRows = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.tournamentId, row.id))
    .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.position));
  const battles = await matchBattleIds(
    db,
    matchRows.map((match) => match.id),
  );
  const byRound = new Map<number, TournamentMatch[]>();
  for (const match of matchRows) {
    const list = byRound.get(match.round) ?? [];
    list.push(toMatch(match, battles.get(match.id) ?? []));
    byRound.set(match.round, list);
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    format: row.format,
    status: row.status,
    createdBy: await creatorOf(db, row.createdByUserId),
    agent: row.agent,
    target: row.target,
    entrants: row.entrants,
    rounds: [...byRound.keys()]
      .sort((a, b) => a - b)
      .map((index) => ({ index, matches: byRound.get(index) ?? [] })),
    winner: row.winner,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

// ---- creation -----------------------------------------------------------------------------------

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'tournament'
  );
}

/**
 * Seed the entrants: highest community `overall` rating first, an unrated or uncatalogued harness at
 * the default 1500, ties broken by the order the creator listed them in. Seeds are 1-based.
 */
async function seedEntrants(db: ArenaDatabase, req: CreateTournamentRequest): Promise<TournamentEntrant[]> {
  const resolved = await Promise.all(
    req.entrants.map(async (entrant, index) => {
      const slug = slugForCompetitor(entrant);
      const [harness] = await db
        .select({ id: harnesses.id })
        .from(harnesses)
        .where(eq(harnesses.slug, slug))
        .limit(1);
      let rating = RATING_DEFAULT;
      if (harness) {
        const [row] = await db
          .select({ rating: ratings.rating })
          .from(ratings)
          .where(
            and(
              eq(ratings.harnessId, harness.id),
              eq(ratings.agentId, req.agent.id),
              eq(ratings.category, 'overall'),
              eq(ratings.pool, 'community'),
            ),
          )
          .limit(1);
        if (row) rating = row.rating;
      }
      return {
        index,
        label: entrant.label ?? entrant.harness.source,
        harness: entrant.harness,
        harnessSlug: harness ? slug : null,
        rating,
      };
    }),
  );

  const ranked = [...resolved].sort((a, b) =>
    b.rating === a.rating ? a.index - b.index : b.rating - a.rating,
  );
  const seedByIndex = new Map<number, number>();
  ranked.forEach((entrant, position) => seedByIndex.set(entrant.index, position + 1));

  return resolved.map((entrant) => ({
    index: entrant.index,
    label: entrant.label,
    harness: entrant.harness,
    harnessSlug: entrant.harnessSlug,
    seed: seedByIndex.get(entrant.index) ?? null,
  }));
}

export interface TournamentActor {
  createdByUserId: string | null;
}

export async function createTournament(
  db: ArenaDatabase,
  req: CreateTournamentRequest,
  actor: TournamentActor,
): Promise<Tournament> {
  const entrants = await seedEntrants(db, req);
  const entrantBySeed = new Map<number, number>();
  for (const entrant of entrants) {
    if (entrant.seed !== null) entrantBySeed.set(entrant.seed, entrant.index);
  }

  let benchmarkVersionId: string | null = null;
  if (req.target.kind === 'benchmark') {
    const [row] = await db
      .select({ id: benchmarkVersions.id })
      .from(benchmarkVersions)
      .where(eq(benchmarkVersions.id, req.target.versionId))
      .limit(1);
    benchmarkVersionId = row?.id ?? null;
  }

  const id = makeId('tournament');
  const slug = `${slugify(req.name)}-${id.slice(-6)}`;
  const [row] = await db
    .insert(tournaments)
    .values({
      id,
      slug,
      name: req.name,
      description: req.description ?? null,
      format: req.format,
      status: 'draft',
      createdByUserId: actor.createdByUserId,
      agent: req.agent,
      target: req.target,
      benchmarkVersionId,
      entrants,
      winner: null,
      visibility: req.visibility,
    })
    .returning();
  if (!row) throw new Error('createTournament: the insert returned no row');

  const bracket = buildBracket(entrants.length);
  const rows = bracket.map((match) => {
    const entrantA = match.a === null ? null : (entrantBySeed.get(match.a) ?? null);
    const entrantB = match.b === null ? null : (entrantBySeed.get(match.b) ?? null);
    return {
      id: makeId('tournamentMatch'),
      tournamentId: id,
      round: match.round,
      position: match.position,
      entrantA,
      entrantB,
      bye: match.bye,
      // a bye is settled the moment the bracket exists; nobody runs a battle for it
      winner: match.bye ? entrantA : null,
      settledBy: match.bye ? ('bye' as const) : null,
    };
  });
  await db.insert(tournamentMatches).values(rows);

  // push every bye winner into the round it feeds, so round 1 starts with real slots
  for (const match of rows) {
    if (!match.bye || match.winner === null) continue;
    await advanceWinner(db, id, match.round, match.position, match.winner);
  }

  const created = await getTournament(db, id);
  if (!created) throw new Error('createTournament: the tournament disappeared after insert');
  return created;
}

// ---- reads --------------------------------------------------------------------------------------

async function rowFor(db: ArenaDatabase, idOrSlug: string): Promise<TournamentRow | null> {
  const [byId] = await db.select().from(tournaments).where(eq(tournaments.id, idOrSlug)).limit(1);
  if (byId) return byId;
  const [bySlug] = await db.select().from(tournaments).where(eq(tournaments.slug, idOrSlug)).limit(1);
  return bySlug ?? null;
}

export async function getTournament(db: ArenaDatabase, idOrSlug: string): Promise<Tournament | null> {
  const row = await rowFor(db, idOrSlug);
  return row ? toTournament(db, row) : null;
}

export interface ListTournamentsOptions {
  status?: TournamentStatus;
  limit?: number;
}

export async function listTournaments(
  db: ArenaDatabase,
  opts: ListTournamentsOptions = {},
): Promise<TournamentListItem[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? TOURNAMENT_LIST_LIMIT), TOURNAMENT_LIST_MAX);
  const filters = [eq(tournaments.visibility, 'public')];
  if (opts.status) filters.push(eq(tournaments.status, opts.status));
  const rows = await db
    .select()
    .from(tournaments)
    .where(and(...filters))
    .orderBy(desc(tournaments.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    format: row.format,
    entrants: row.entrants.length,
    rounds: row.entrants.length >= 2 ? bracketRounds(row.entrants.length) : 0,
    winner: row.winner,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Matches with both slots filled and no winner: exactly what `arena tournament play` must run. */
export async function pendingMatches(db: ArenaDatabase, tournamentId: string): Promise<TournamentMatch[]> {
  const rows = await db
    .select()
    .from(tournamentMatches)
    .where(
      and(
        eq(tournamentMatches.tournamentId, tournamentId),
        isNotNull(tournamentMatches.entrantA),
        isNotNull(tournamentMatches.entrantB),
        isNull(tournamentMatches.winner),
      ),
    )
    .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.position));
  const battles = await matchBattleIds(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toMatch(row, battles.get(row.id) ?? []));
}

/** Everything links.ts needs to check that an uploaded battle really is this match. */
export interface MatchContext {
  tournament: TournamentRow;
  match: TournamentMatchRow;
  entrantA: TournamentEntrant | null;
  entrantB: TournamentEntrant | null;
}

export async function getMatchContext(db: ArenaDatabase, matchId: string): Promise<MatchContext | null> {
  const [match] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.id, matchId)).limit(1);
  if (!match) return null;
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, match.tournamentId))
    .limit(1);
  if (!tournament) return null;
  const entrantAt = (index: number | null): TournamentEntrant | null =>
    index === null ? null : (tournament.entrants.find((entrant) => entrant.index === index) ?? null);
  return {
    tournament,
    match,
    entrantA: entrantAt(match.entrantA),
    entrantB: entrantAt(match.entrantB),
  };
}

// ---- state changes ------------------------------------------------------------------------------

export type TournamentOutcome =
  | { ok: true; tournament: Tournament }
  | { ok: false; code: 'not_found' | 'forbidden' | 'conflict'; reason: string };

/** draft -> running. Only the creator opens their own tournament for play. */
export async function startTournament(
  db: ArenaDatabase,
  idOrSlug: string,
  userId: string,
): Promise<TournamentOutcome> {
  const row = await rowFor(db, idOrSlug);
  if (!row) return { ok: false, code: 'not_found', reason: 'no tournament with that id or slug' };
  if (row.createdByUserId !== userId) {
    return { ok: false, code: 'forbidden', reason: 'only the person who created a tournament can start it' };
  }
  if (row.status === 'running') {
    const current = await toTournament(db, row);
    return { ok: true, tournament: current };
  }
  if (row.status !== 'draft') {
    return { ok: false, code: 'conflict', reason: `this tournament is ${row.status}, not a draft` };
  }
  const now = new Date();
  await db
    .update(tournaments)
    .set({ status: 'running', startedAt: now, updatedAt: now })
    .where(eq(tournaments.id, row.id));
  const started = await getTournament(db, row.id);
  if (!started) return { ok: false, code: 'not_found', reason: 'no tournament with that id or slug' };
  return { ok: true, tournament: started };
}

/**
 * Put the winner of (round, position) into the slot it feeds. Returns false when there is no next
 * match, which is how the caller recognises the final.
 */
async function advanceWinner(
  db: ArenaDatabase,
  tournamentId: string,
  round: number,
  position: number,
  entrantIndex: number,
): Promise<boolean> {
  const next = nextSlot(round, position);
  const [target] = await db
    .select({ id: tournamentMatches.id })
    .from(tournamentMatches)
    .where(
      and(
        eq(tournamentMatches.tournamentId, tournamentId),
        eq(tournamentMatches.round, next.round),
        eq(tournamentMatches.position, next.position),
      ),
    )
    .limit(1);
  if (!target) return false;
  await db
    .update(tournamentMatches)
    .set({
      ...(next.slot === 'a' ? { entrantA: entrantIndex } : { entrantB: entrantIndex }),
      updatedAt: new Date(),
    })
    .where(eq(tournamentMatches.id, target.id));
  return true;
}

export interface SettleResult {
  matchId: string;
  winner: number;
  settledBy: 'verdict' | 'bye' | 'seed' | 'forfeit';
  /** the match the winner advanced into, or null when this was the final */
  advancedTo: string | null;
  tournamentCompleted: boolean;
}

function seedOf(entrants: readonly TournamentEntrant[], index: number | null): number {
  if (index === null) return Number.MAX_SAFE_INTEGER;
  return entrants.find((entrant) => entrant.index === index)?.seed ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Settle a match from the battle that was run for it. A decided verdict names the winner; a tie or an
 * inconclusive verdict advances the higher seed and records `settledBy: 'seed'` so the bracket never
 * pretends a battle decided it. Idempotent: an already settled match is returned unchanged.
 */
export async function settleMatch(
  db: ArenaDatabase,
  matchId: string,
  record: BattleRecord,
): Promise<SettleResult | null> {
  const context = await getMatchContext(db, matchId);
  if (!context) return null;
  const { match, tournament } = context;
  if (match.winner !== null) {
    return {
      matchId,
      winner: match.winner,
      settledBy: match.settledBy ?? 'verdict',
      advancedTo: null,
      tournamentCompleted: tournament.status === 'completed',
    };
  }
  if (match.entrantA === null || match.entrantB === null) return null;

  const verdict = record.verdict?.winner ?? null;
  let winner: number;
  let settledBy: 'verdict' | 'seed';
  if (verdict === 'a') {
    winner = match.entrantA;
    settledBy = 'verdict';
  } else if (verdict === 'b') {
    winner = match.entrantB;
    settledBy = 'verdict';
  } else {
    const seedA = seedOf(tournament.entrants, match.entrantA);
    const seedB = seedOf(tournament.entrants, match.entrantB);
    winner = seedA <= seedB ? match.entrantA : match.entrantB;
    settledBy = 'seed';
  }

  const now = new Date();
  await db
    .update(tournamentMatches)
    .set({ winner, settledBy, updatedAt: now })
    .where(eq(tournamentMatches.id, matchId));

  const advanced = await advanceWinner(db, tournament.id, match.round, match.position, winner);
  let tournamentCompleted = false;
  if (!advanced) {
    await db
      .update(tournaments)
      .set({ winner, status: 'completed', completedAt: now, updatedAt: now })
      .where(eq(tournaments.id, tournament.id));
    tournamentCompleted = true;
  }

  let advancedTo: string | null = null;
  if (advanced) {
    const next = nextSlot(match.round, match.position);
    const [target] = await db
      .select({ id: tournamentMatches.id })
      .from(tournamentMatches)
      .where(
        and(
          eq(tournamentMatches.tournamentId, tournament.id),
          eq(tournamentMatches.round, next.round),
          eq(tournamentMatches.position, next.position),
        ),
      )
      .limit(1);
    advancedTo = target?.id ?? null;
  }

  return { matchId, winner, settledBy, advancedTo, tournamentCompleted };
}
