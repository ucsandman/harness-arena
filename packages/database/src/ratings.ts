import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { BattleRecord, RatingCategory, RatingHistoryPoint, RatingPool } from '@harness-arena/protocol';
import {
  RATING_CATEGORIES,
  RATING_DEFAULT,
  RATING_DEFAULT_DEVIATION,
  RATING_DEVIATION_GROWTH_C,
  RATING_FORM_WINDOW,
  RATING_MAX_RANKED_DEVIATION,
  RATING_MIN_DEVIATION,
  RATING_MIN_SAMPLE,
} from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import { harnessVersions, harnesses } from './schema/catalog.js';
import { battleRuns, battles } from './schema/battles.js';
import { ratingEvents, ratings } from './schema/ratings.js';
import { harnessSlug } from './derive.js';

/**
 * Rating model
 * ------------
 * Glicko-1 (Glickman 1999) on the battle verdict, per (harness, agent, category, pool):
 *
 *   q      = ln(10) / 400
 *   g(RD)  = 1 / sqrt(1 + 3 q² RD² / π²)
 *   E      = 1 / (1 + 10^(-g(RDj) (r - rj) / 400))
 *   d²     = 1 / (q² g(RDj)² E (1 - E))
 *   r'     = r + q / (1/RD² + 1/d²) · g(RDj) · (s - E)
 *   RD'    = sqrt( 1 / (1/RD² + 1/d²) )
 *
 * Unlike the Elo this replaces, the deviation is a real quantity: it shrinks as evidence arrives and
 * grows again while a harness sits idle (sqrt(RD² + c²·days), capped at the default 350), so a rating
 * nobody has tested for six months carries a visibly wider interval instead of a stale certainty. A
 * rating is provisional — and excluded from ranked order — below RATING_MIN_SAMPLE decided battles or
 * above RATING_MAX_RANKED_DEVIATION.
 *
 * Every change is written to `rating_events` with the harness VERSION that earned it, the opponent and
 * the opponent's rating at the time. History is append-only: a correction is a new event, never an
 * edit. Community (self-reported) and verified (Arena-executed) pools are never mixed; demo battles
 * and battles that failed the integrity checks never move a rating at all.
 */

export const RATING_Q = Math.LN10 / 400;
const MS_PER_DAY = 86_400_000;

export type RatingOutcome = 'win' | 'loss' | 'tie';

export interface RatingState {
  rating: number;
  deviation: number;
  battles: number;
  wins: number;
  losses: number;
  ties: number;
  provisional: boolean;
  peakRating: number;
  /** last RATING_FORM_WINDOW outcomes, oldest first, as W/L/T */
  form: string;
  lastBattleAt: Date | null;
}

export function initialRatingState(): RatingState {
  return {
    rating: RATING_DEFAULT,
    deviation: RATING_DEFAULT_DEVIATION,
    battles: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    provisional: true,
    peakRating: RATING_DEFAULT,
    form: '',
    lastBattleAt: null,
  };
}

function clampDeviation(deviation: number): number {
  return Math.min(RATING_DEFAULT_DEVIATION, Math.max(RATING_MIN_DEVIATION, deviation));
}

/** Glicko's g(RD): how much an uncertain opponent's result is allowed to move a rating. */
export function gFactor(deviation: number): number {
  return 1 / Math.sqrt(1 + (3 * RATING_Q ** 2 * deviation ** 2) / Math.PI ** 2);
}

/**
 * Probability that `rating` beats an opponent. With a certain opponent (deviation 0) this is the
 * plain logistic curve, so it stays symmetric: e(a,b) + e(b,a) === 1.
 */
export function expectedScore(rating: number, opponentRating: number, opponentDeviation = 0): number {
  return 1 / (1 + 10 ** ((gFactor(opponentDeviation) * (opponentRating - rating)) / 400));
}

/** Idle time widens the interval: sqrt(RD² + c²·days), never past the default 350. */
export function inflateDeviation(deviation: number, days: number): number {
  if (!(days > 0)) return clampDeviation(deviation);
  return clampDeviation(Math.sqrt(deviation ** 2 + RATING_DEVIATION_GROWTH_C ** 2 * days));
}

export function daysSince(from: Date | null, now: Date): number {
  if (!from) return 0;
  const ms = now.getTime() - from.getTime();
  return ms > 0 ? ms / MS_PER_DAY : 0;
}

/** Provisional while the sample is thin OR the interval is too wide to order against anyone. */
export function isProvisional(battles: number, deviation: number): boolean {
  return battles < RATING_MIN_SAMPLE || deviation > RATING_MAX_RANKED_DEVIATION;
}

export function scoreFor(outcome: RatingOutcome): number {
  return outcome === 'win' ? 1 : outcome === 'tie' ? 0.5 : 0;
}

function formLetter(outcome: RatingOutcome): string {
  return outcome === 'win' ? 'W' : outcome === 'loss' ? 'L' : 'T';
}

/** Pure Glicko-1 step, including the idle inflation. Returns the next state; never mutates the input. */
export function updateRating(
  state: RatingState,
  opponent: { rating: number; deviation: number },
  outcome: RatingOutcome,
  now: Date = new Date(),
): RatingState {
  const deviation = inflateDeviation(state.deviation, daysSince(state.lastBattleAt, now));
  const g = gFactor(opponent.deviation);
  const expected = expectedScore(state.rating, opponent.rating, opponent.deviation);
  const dSquared = 1 / (RATING_Q ** 2 * g ** 2 * expected * (1 - expected));
  const precision = 1 / deviation ** 2 + (Number.isFinite(dSquared) ? 1 / dSquared : 0);
  const rating = state.rating + (RATING_Q / precision) * g * (scoreFor(outcome) - expected);
  const nextDeviation = clampDeviation(Math.sqrt(1 / precision));
  const battles = state.battles + 1;

  return {
    rating,
    deviation: nextDeviation,
    battles,
    wins: state.wins + (outcome === 'win' ? 1 : 0),
    losses: state.losses + (outcome === 'loss' ? 1 : 0),
    ties: state.ties + (outcome === 'tie' ? 1 : 0),
    provisional: isProvisional(battles, nextDeviation),
    peakRating: Math.max(state.peakRating, rating),
    form: (state.form + formLetter(outcome)).slice(-RATING_FORM_WINDOW),
    lastBattleAt: now,
  };
}

/** A free-form spec category becomes a known RatingCategory, or `overall`. */
export function mapCategory(raw: string | null | undefined): RatingCategory {
  if (!raw) return 'overall';
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const match = RATING_CATEGORIES.find((category) => category === normalized);
  return match ?? 'overall';
}

/** Every battle counts towards `overall` plus its own category (deduplicated). */
export function ratingCategoriesFor(raw: string | null | undefined): RatingCategory[] {
  const mapped = mapCategory(raw);
  return mapped === 'overall' ? ['overall'] : ['overall', mapped];
}

export function outcomeForSide(side: 'a' | 'b', winner: 'a' | 'b' | 'tie'): RatingOutcome {
  if (winner === 'tie') return 'tie';
  return winner === side ? 'win' : 'loss';
}

/** Community unless the battle is verification-eligible; a requested pool is clamped down, never up. */
export function poolForRecord(record: BattleRecord, requested?: RatingPool): RatingPool {
  const eligible = record.verification.eligible;
  const wanted = requested ?? (eligible ? 'verified' : 'community');
  return wanted === 'verified' && eligible ? 'verified' : 'community';
}

export type ApplySkipReason =
  'demo' | 'no_decision' | 'already_applied' | 'harness_missing' | 'same_competitor' | 'integrity';

export interface RatingChange {
  harnessId: string;
  agentId: string;
  category: RatingCategory;
  pool: RatingPool;
  ratingBefore: number;
  ratingAfter: number;
}

export interface ApplyRatingsResult {
  applied: boolean;
  reason?: ApplySkipReason;
  pool: RatingPool;
  categories: RatingCategory[];
  changes: RatingChange[];
}

type RatingKey = { harnessId: string; agentId: string; category: RatingCategory; pool: RatingPool };

async function loadState(db: ArenaDatabase, key: RatingKey): Promise<RatingState> {
  const [row] = await db
    .select()
    .from(ratings)
    .where(
      and(
        eq(ratings.harnessId, key.harnessId),
        eq(ratings.agentId, key.agentId),
        eq(ratings.category, key.category),
        eq(ratings.pool, key.pool),
      ),
    )
    .limit(1);
  if (!row) return initialRatingState();
  return {
    rating: row.rating,
    deviation: row.deviation,
    battles: row.battles,
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    provisional: row.provisional,
    peakRating: row.peakRating,
    form: row.form,
    lastBattleAt: row.lastBattleAt,
  };
}

async function writeState(db: ArenaDatabase, key: RatingKey, next: RatingState): Promise<void> {
  const columns = {
    rating: next.rating,
    deviation: next.deviation,
    battles: next.battles,
    wins: next.wins,
    losses: next.losses,
    ties: next.ties,
    provisional: next.provisional,
    peakRating: next.peakRating,
    form: next.form,
    lastBattleAt: next.lastBattleAt,
    updatedAt: new Date(),
  };
  await db
    .insert(ratings)
    .values({ ...key, ...columns })
    .onConflictDoUpdate({
      target: [ratings.harnessId, ratings.agentId, ratings.category, ratings.pool],
      set: columns,
    });
}

/**
 * Apply one battle's verdict to the ratings table. Idempotent per battle: a second call finds the
 * battle's rating_events rows and does nothing. A battle only counts when the stored row says it is
 * rating-eligible, which is the server's own integrity verdict (`upsertBattleFromRecord` computes it
 * and never trusts the client's copy), so this function cannot be talked into rating a duplicate, a
 * self-play or an unpinned harness by an uploader.
 */
export async function applyBattleToRatings(
  db: ArenaDatabase,
  record: BattleRecord,
  opts: { pool?: RatingPool; now?: Date } = {},
): Promise<ApplyRatingsResult> {
  const pool = poolForRecord(record, opts.pool);
  const categories = ratingCategoriesFor(record.spec.category);
  const now = opts.now ?? new Date();
  const empty: ApplyRatingsResult = { applied: false, pool, categories, changes: [] };

  if (record.demo) return { ...empty, reason: 'demo' };
  const winner = record.verdict?.winner;
  if (!winner || winner === 'inconclusive') return { ...empty, reason: 'no_decision' };

  return db.transaction(async (tx) => {
    const seen = await tx
      .select({ id: ratingEvents.id })
      .from(ratingEvents)
      .where(eq(ratingEvents.battleId, record.id))
      .limit(1);
    if (seen.length > 0) return { ...empty, reason: 'already_applied' as const };

    const runRows = await tx
      .select({ side: battleRuns.side, harnessVersionId: battleRuns.harnessVersionId })
      .from(battleRuns)
      .where(eq(battleRuns.battleId, record.id));
    const versionIdFor = (side: 'a' | 'b'): string | null =>
      runRows.find((row) => row.side === side)?.harnessVersionId ?? null;

    const sides = (['a', 'b'] as const).map((side) => {
      const run = record.runs[side];
      return { side, agentId: run.agent.id, slug: harnessSlug(run.harness) };
    });
    const resolved: { side: 'a' | 'b'; agentId: string; harnessId: string }[] = [];
    for (const entry of sides) {
      const [row] = await tx
        .select({ id: harnesses.id })
        .from(harnesses)
        .where(eq(harnesses.slug, entry.slug))
        .limit(1);
      if (!row) return { ...empty, reason: 'harness_missing' as const };
      resolved.push({ side: entry.side, agentId: entry.agentId, harnessId: row.id });
    }

    const [a, b] = resolved as [(typeof resolved)[number], (typeof resolved)[number]];
    if (a.harnessId === b.harnessId && a.agentId === b.agentId) {
      return { ...empty, reason: 'same_competitor' as const };
    }

    // The integrity gate: the stored projection of the server's own checks, not the record's claim.
    const [battleRow] = await tx
      .select({ ratingEligible: battles.ratingEligible })
      .from(battles)
      .where(eq(battles.id, record.id))
      .limit(1);
    if (!battleRow?.ratingEligible) return { ...empty, reason: 'integrity' as const };

    const changes: RatingChange[] = [];
    for (const category of categories) {
      const keyA: RatingKey = { harnessId: a.harnessId, agentId: a.agentId, category, pool };
      const keyB: RatingKey = { harnessId: b.harnessId, agentId: b.agentId, category, pool };
      const stateA = await loadState(tx, keyA);
      const stateB = await loadState(tx, keyB);
      const outcomeA = outcomeForSide('a', winner);
      const outcomeB = outcomeForSide('b', winner);
      // Both updates read the ratings as they were before this battle, so the order of the two sides
      // cannot change the result.
      const nextA = updateRating(
        stateA,
        { rating: stateB.rating, deviation: stateB.deviation },
        outcomeA,
        now,
      );
      const nextB = updateRating(
        stateB,
        { rating: stateA.rating, deviation: stateA.deviation },
        outcomeB,
        now,
      );
      await writeState(tx, keyA, nextA);
      await writeState(tx, keyB, nextB);
      await tx.insert(ratingEvents).values([
        {
          id: randomUUID(),
          battleId: record.id,
          ...keyA,
          harnessVersionId: versionIdFor('a'),
          opponentHarnessId: b.harnessId,
          opponentRating: stateB.rating,
          outcome: outcomeA,
          ratingBefore: stateA.rating,
          ratingAfter: nextA.rating,
          deviationBefore: stateA.deviation,
          deviationAfter: nextA.deviation,
          createdAt: now,
        },
        {
          id: randomUUID(),
          battleId: record.id,
          ...keyB,
          harnessVersionId: versionIdFor('b'),
          opponentHarnessId: a.harnessId,
          opponentRating: stateA.rating,
          outcome: outcomeB,
          ratingBefore: stateB.rating,
          ratingAfter: nextB.rating,
          deviationBefore: stateB.deviation,
          deviationAfter: nextB.deviation,
          createdAt: now,
        },
      ]);
      changes.push(
        { ...keyA, ratingBefore: stateA.rating, ratingAfter: nextA.rating },
        { ...keyB, ratingBefore: stateB.rating, ratingAfter: nextB.rating },
      );
    }

    return { applied: true, pool, categories, changes };
  });
}

/** Rows for the leaderboard, ordered by rating with provisional entries last. */
export interface LeaderboardRow {
  harnessId: string;
  harnessSlug: string;
  harnessName: string;
  agentId: string;
  category: RatingCategory;
  pool: RatingPool;
  rating: number;
  deviation: number;
  battles: number;
  wins: number;
  losses: number;
  ties: number;
  provisional: boolean;
  peakRating: number;
  form: string;
  lastBattleAt: Date | null;
  updatedAt: Date;
}

export async function getLeaderboard(
  db: ArenaDatabase,
  opts: { category?: RatingCategory; pool?: RatingPool; agentId?: string; limit?: number } = {},
): Promise<LeaderboardRow[]> {
  const category = opts.category ?? 'overall';
  const pool = opts.pool ?? 'community';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.agentId
    ? and(eq(ratings.category, category), eq(ratings.pool, pool), eq(ratings.agentId, opts.agentId))
    : and(eq(ratings.category, category), eq(ratings.pool, pool));

  return (
    db
      .select({
        harnessId: ratings.harnessId,
        harnessSlug: harnesses.slug,
        harnessName: harnesses.name,
        agentId: ratings.agentId,
        category: ratings.category,
        pool: ratings.pool,
        rating: ratings.rating,
        deviation: ratings.deviation,
        battles: ratings.battles,
        wins: ratings.wins,
        losses: ratings.losses,
        ties: ratings.ties,
        provisional: ratings.provisional,
        peakRating: ratings.peakRating,
        form: ratings.form,
        lastBattleAt: ratings.lastBattleAt,
        updatedAt: ratings.updatedAt,
      })
      .from(ratings)
      .innerJoin(harnesses, eq(harnesses.id, ratings.harnessId))
      .where(where)
      // provisional sorts false-first in Postgres: every ranked rating by rating desc, then the
      // provisional ones, also by rating desc.
      .orderBy(sql`${ratings.provisional} asc`, sql`${ratings.rating} desc`, harnesses.slug)
      .limit(limit)
  );
}

export interface RatingQuery {
  agentId: string;
  category?: RatingCategory;
  pool?: RatingPool;
}

/** One rating row for a harness slug, or null when that pairing has never been rated. */
export async function getRating(
  db: ArenaDatabase,
  slug: string,
  query: RatingQuery,
): Promise<LeaderboardRow | null> {
  const [row] = await db
    .select({
      harnessId: ratings.harnessId,
      harnessSlug: harnesses.slug,
      harnessName: harnesses.name,
      agentId: ratings.agentId,
      category: ratings.category,
      pool: ratings.pool,
      rating: ratings.rating,
      deviation: ratings.deviation,
      battles: ratings.battles,
      wins: ratings.wins,
      losses: ratings.losses,
      ties: ratings.ties,
      provisional: ratings.provisional,
      peakRating: ratings.peakRating,
      form: ratings.form,
      lastBattleAt: ratings.lastBattleAt,
      updatedAt: ratings.updatedAt,
    })
    .from(ratings)
    .innerJoin(harnesses, eq(harnesses.id, ratings.harnessId))
    .where(
      and(
        eq(harnesses.slug, slug),
        eq(ratings.agentId, query.agentId),
        eq(ratings.category, query.category ?? 'overall'),
        eq(ratings.pool, query.pool ?? 'community'),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface RatingHistoryQuery {
  agentId?: string;
  category?: RatingCategory;
  pool?: RatingPool;
  limit?: number;
}

const opponentHarnesses = alias(harnesses, 'opponent_harnesses');

/**
 * The rating curve for one harness, oldest point first. Straight off `rating_events`, so what the
 * chart shows is the audit trail itself: every point names the battle, the opponent and the harness
 * commit that earned it. `limit` takes the most recent points and then restores time order.
 */
export async function getRatingHistory(
  db: ArenaDatabase,
  slug: string,
  query: RatingHistoryQuery = {},
): Promise<RatingHistoryPoint[]> {
  const [harness] = await db
    .select({ id: harnesses.id })
    .from(harnesses)
    .where(eq(harnesses.slug, slug))
    .limit(1);
  if (!harness) return [];

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const conditions = [eq(ratingEvents.harnessId, harness.id)];
  if (query.agentId) conditions.push(eq(ratingEvents.agentId, query.agentId));
  conditions.push(eq(ratingEvents.category, query.category ?? 'overall'));
  conditions.push(eq(ratingEvents.pool, query.pool ?? 'community'));

  const rows = await db
    .select({
      battleId: ratingEvents.battleId,
      createdAt: ratingEvents.createdAt,
      ratingBefore: ratingEvents.ratingBefore,
      ratingAfter: ratingEvents.ratingAfter,
      deviationAfter: ratingEvents.deviationAfter,
      outcome: ratingEvents.outcome,
      opponentSlug: opponentHarnesses.slug,
      harnessCommit: harnessVersions.commit,
    })
    .from(ratingEvents)
    .leftJoin(harnessVersions, eq(harnessVersions.id, ratingEvents.harnessVersionId))
    .leftJoin(opponentHarnesses, eq(opponentHarnesses.id, ratingEvents.opponentHarnessId))
    .where(and(...conditions))
    .orderBy(desc(ratingEvents.createdAt), desc(ratingEvents.battleId))
    .limit(limit);

  return rows
    .map((row) => ({
      battleId: row.battleId,
      at: row.createdAt.toISOString(),
      rating: row.ratingAfter,
      deviation: row.deviationAfter,
      delta: row.ratingAfter - row.ratingBefore,
      outcome: row.outcome,
      opponentSlug: row.opponentSlug ?? null,
      harnessCommit: row.harnessCommit ?? null,
    }))
    .reverse();
}
