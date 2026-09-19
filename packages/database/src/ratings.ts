import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { BattleRecord, RatingCategory, RatingPool } from '@harness-arena/protocol';
import {
  RATING_CATEGORIES,
  RATING_DEFAULT,
  RATING_DEFAULT_DEVIATION,
  RATING_MIN_SAMPLE,
} from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import { harnesses } from './schema/catalog.js';
import { ratingEvents, ratings } from './schema/ratings.js';
import { harnessSlug } from './derive.js';

/**
 * Rating model
 * ------------
 * Plain Elo with K = 32 on the battle verdict, plus a confidence term:
 *
 *   expected(a, b) = 1 / (1 + 10 ^ ((b - a) / 400))
 *   rating'        = rating + K * (score - expected),  score = 1 win / 0.5 tie / 0 loss
 *   deviation      = max(50, 350 / sqrt(games + 1))
 *
 * The deviation is not a Glicko RD update: it is a documented, monotonically shrinking function of
 * the sample size, so the UI can show a confidence interval without claiming more rigour than this
 * has. Below RATING_MIN_SAMPLE decided battles a rating is provisional and excluded from ranked
 * lists. Community (self-reported) and verified (Arena-executed) pools are never mixed, and demo
 * battles never move a rating.
 */

export const RATING_K = 32;
export const RATING_MIN_DEVIATION = 50;

export type RatingOutcome = 'win' | 'loss' | 'tie';

export interface RatingState {
  rating: number;
  deviation: number;
  battles: number;
  wins: number;
  losses: number;
  ties: number;
  provisional: boolean;
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
  };
}

/** Probability that `rating` beats `opponentRating`. Symmetric: e(a,b) + e(b,a) === 1. */
export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

export function deviationFor(games: number): number {
  return Math.max(RATING_MIN_DEVIATION, RATING_DEFAULT_DEVIATION / Math.sqrt(games + 1));
}

export function isProvisional(battles: number): boolean {
  return battles < RATING_MIN_SAMPLE;
}

export function scoreFor(outcome: RatingOutcome): number {
  return outcome === 'win' ? 1 : outcome === 'tie' ? 0.5 : 0;
}

/** Pure Elo step. Returns the next state; never mutates the input. */
export function updateRating(
  state: RatingState,
  opponentRating: number,
  outcome: RatingOutcome,
): RatingState {
  const expected = expectedScore(state.rating, opponentRating);
  const battles = state.battles + 1;
  return {
    rating: state.rating + RATING_K * (scoreFor(outcome) - expected),
    deviation: deviationFor(battles),
    battles,
    wins: state.wins + (outcome === 'win' ? 1 : 0),
    losses: state.losses + (outcome === 'loss' ? 1 : 0),
    ties: state.ties + (outcome === 'tie' ? 1 : 0),
    provisional: isProvisional(battles),
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
  'demo' | 'no_decision' | 'already_applied' | 'harness_missing' | 'same_competitor';

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

async function loadState(
  db: ArenaDatabase,
  key: { harnessId: string; agentId: string; category: RatingCategory; pool: RatingPool },
): Promise<RatingState> {
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
  };
}

async function writeState(
  db: ArenaDatabase,
  key: { harnessId: string; agentId: string; category: RatingCategory; pool: RatingPool },
  next: RatingState,
): Promise<void> {
  await db
    .insert(ratings)
    .values({ ...key, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [ratings.harnessId, ratings.agentId, ratings.category, ratings.pool],
      set: {
        rating: next.rating,
        deviation: next.deviation,
        battles: next.battles,
        wins: next.wins,
        losses: next.losses,
        ties: next.ties,
        provisional: next.provisional,
        updatedAt: new Date(),
      },
    });
}

/**
 * Apply one battle's verdict to the ratings table. Idempotent per battle: a second call finds the
 * battle's rating_events rows and does nothing. Demo battles and undecided verdicts never count.
 * Requires the battle's harnesses to exist (call upsertBattleFromRecord first).
 */
export async function applyBattleToRatings(
  db: ArenaDatabase,
  record: BattleRecord,
  opts: { pool?: RatingPool } = {},
): Promise<ApplyRatingsResult> {
  const pool = poolForRecord(record, opts.pool);
  const categories = ratingCategoriesFor(record.spec.category);
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

    const changes: RatingChange[] = [];
    for (const category of categories) {
      const keyA = { harnessId: a.harnessId, agentId: a.agentId, category, pool };
      const keyB = { harnessId: b.harnessId, agentId: b.agentId, category, pool };
      const stateA = await loadState(tx, keyA);
      const stateB = await loadState(tx, keyB);
      const nextA = updateRating(stateA, stateB.rating, outcomeForSide('a', winner));
      const nextB = updateRating(stateB, stateA.rating, outcomeForSide('b', winner));
      await writeState(tx, keyA, nextA);
      await writeState(tx, keyB, nextB);
      await tx.insert(ratingEvents).values([
        {
          id: randomUUID(),
          battleId: record.id,
          ...keyA,
          ratingBefore: stateA.rating,
          ratingAfter: nextA.rating,
        },
        {
          id: randomUUID(),
          battleId: record.id,
          ...keyB,
          ratingBefore: stateB.rating,
          ratingAfter: nextB.rating,
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

  return db
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
      updatedAt: ratings.updatedAt,
    })
    .from(ratings)
    .innerJoin(harnesses, eq(harnesses.id, ratings.harnessId))
    .where(where)
    .orderBy(sql`${ratings.provisional} asc`, sql`${ratings.rating} desc`, harnesses.slug)
    .limit(limit);
}
