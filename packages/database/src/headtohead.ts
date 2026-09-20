import { and, desc, eq, gte, inArray, like, lte, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { HeadToHead, HeadToHeadFilter } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import { battleRuns, battles } from './schema/battles.js';
import { benchmarkVersions, benchmarks } from './schema/arena.js';
import { harnessVersions, harnesses } from './schema/catalog.js';
import { mapCategory } from './ratings.js';

/**
 * Head-to-head: one harness against one other, over the public battles that actually happened.
 *
 * Nothing here is modelled or predicted. A filter narrows the set of real battles (same agent, same
 * category, same pool, same benchmark pack, one commit of the subject, a date range) and the counts
 * come out of that set, so a page can always answer "which battles is this number made of" by listing
 * `recentBattleIds`. Battles with no decided winner are counted separately instead of being dropped,
 * because "we fought nine times and seven were inconclusive" is the important part of that record.
 */

const subjectRun = alias(battleRuns, 'h2h_subject_run');
const opponentRun = alias(battleRuns, 'h2h_opponent_run');
const subjectVersion = alias(harnessVersions, 'h2h_subject_version');

export interface OpponentRecord {
  slug: string;
  name: string;
  battles: number;
  wins: number;
  losses: number;
  ties: number;
  inconclusive: number;
  lastBattleAt: string | null;
}

async function harnessBySlug(
  db: ArenaDatabase,
  slug: string,
): Promise<{ id: string; slug: string; name: string } | null> {
  const [row] = await db
    .select({ id: harnesses.id, slug: harnesses.slug, name: harnesses.name })
    .from(harnesses)
    .where(eq(harnesses.slug, slug))
    .limit(1);
  return row ?? null;
}

type FoughtRow = {
  id: string;
  category: string | null;
  winner: 'a' | 'b' | 'tie' | 'inconclusive' | null;
  createdAt: Date;
  subjectSide: 'a' | 'b';
};

/**
 * Public, completed battles where `harnessId` met `opponentId`, newest first. The join is written
 * twice (subject on A, subject on B) through one pair of aliases, with the side recorded, so the
 * caller never has to guess which run belongs to whom.
 */
async function battlesBetween(
  db: ArenaDatabase,
  harnessId: string,
  opponentId: string,
  filter: HeadToHeadFilter,
  limit: number,
): Promise<FoughtRow[]> {
  const conditions = [
    eq(battles.visibility, 'public'),
    eq(battles.status, 'completed'),
    eq(subjectRun.harnessId, harnessId),
    eq(opponentRun.harnessId, opponentId),
    // the two runs are the two sides of the same battle
    or(
      and(eq(subjectRun.side, 'a'), eq(opponentRun.side, 'b')),
      and(eq(subjectRun.side, 'b'), eq(opponentRun.side, 'a')),
    ),
  ];
  if (filter.agentId) {
    conditions.push(eq(subjectRun.agentId, filter.agentId), eq(opponentRun.agentId, filter.agentId));
  }
  if (filter.pool) {
    conditions.push(eq(battles.verificationKind, filter.pool === 'verified' ? 'cloud' : 'local'));
  }
  if (filter.commit) {
    conditions.push(like(subjectVersion.commit, `${filter.commit}%`));
  }
  if (filter.benchmarkSlug) {
    conditions.push(eq(benchmarks.slug, filter.benchmarkSlug));
  }
  const since = filter.since ? new Date(filter.since) : null;
  if (since && !Number.isNaN(since.getTime())) conditions.push(gte(battles.createdAt, since));
  const until = filter.until ? new Date(filter.until) : null;
  if (until && !Number.isNaN(until.getTime())) conditions.push(lte(battles.createdAt, until));

  const rows = await db
    .select({
      id: battles.id,
      category: battles.category,
      winner: battles.winner,
      createdAt: battles.createdAt,
      subjectSide: subjectRun.side,
    })
    .from(battles)
    .innerJoin(subjectRun, eq(subjectRun.battleId, battles.id))
    .innerJoin(opponentRun, eq(opponentRun.battleId, battles.id))
    .leftJoin(subjectVersion, eq(subjectVersion.id, subjectRun.harnessVersionId))
    .leftJoin(benchmarkVersions, eq(benchmarkVersions.id, battles.benchmarkVersionId))
    .leftJoin(benchmarks, eq(benchmarks.id, benchmarkVersions.benchmarkId))
    .where(and(...conditions))
    .orderBy(desc(battles.createdAt), desc(battles.id))
    .limit(limit);

  // `category` is a free-form spec string; mapCategory is the same mapping the ratings use, so the
  // filter here and the rating it explains can never disagree. `overall` matches every battle.
  const wanted = filter.category;
  return rows.filter(
    (row) => !wanted || wanted === 'overall' || mapCategory(row.category) === wanted,
  ) as FoughtRow[];
}

/** The pair's record under `filter`, or null when either harness is not in the catalogue. */
export async function getHeadToHead(
  db: ArenaDatabase,
  subjectSlug: string,
  opponentSlug: string,
  filter: HeadToHeadFilter = {},
): Promise<HeadToHead | null> {
  const [subject, opponent] = await Promise.all([
    harnessBySlug(db, subjectSlug),
    harnessBySlug(db, opponentSlug),
  ]);
  if (!subject || !opponent) return null;

  const rows = await battlesBetween(db, subject.id, opponent.id, filter, 500);

  let wins = 0;
  let losses = 0;
  let ties = 0;
  let inconclusive = 0;
  for (const row of rows) {
    if (row.winner === 'tie') ties += 1;
    else if (row.winner === 'a' || row.winner === 'b') {
      if (row.winner === row.subjectSide) wins += 1;
      else losses += 1;
    } else inconclusive += 1;
  }
  const decided = wins + losses + ties;

  return {
    subject: { slug: subject.slug, name: subject.name },
    opponent: { slug: opponent.slug, name: opponent.name },
    wins,
    losses,
    ties,
    inconclusive,
    battles: decided,
    winRate: decided === 0 ? null : wins / decided,
    lastBattleAt: rows[0]?.createdAt.toISOString() ?? null,
    recentBattleIds: rows.slice(0, 10).map((row) => row.id),
    filter,
  };
}

/**
 * The harnesses this one has actually fought, most battles first. Used to offer real comparisons on a
 * profile instead of a dropdown of the whole catalogue.
 */
export async function listOpponents(db: ArenaDatabase, slug: string, limit = 10): Promise<OpponentRecord[]> {
  const subject = await harnessBySlug(db, slug);
  if (!subject) return [];

  const rows = await db
    .select({
      id: battles.id,
      winner: battles.winner,
      createdAt: battles.createdAt,
      subjectSide: subjectRun.side,
      opponentHarnessId: opponentRun.harnessId,
    })
    .from(battles)
    .innerJoin(subjectRun, eq(subjectRun.battleId, battles.id))
    .innerJoin(opponentRun, eq(opponentRun.battleId, battles.id))
    .where(
      and(
        eq(battles.visibility, 'public'),
        eq(battles.status, 'completed'),
        eq(subjectRun.harnessId, subject.id),
        or(
          and(eq(subjectRun.side, 'a'), eq(opponentRun.side, 'b')),
          and(eq(subjectRun.side, 'b'), eq(opponentRun.side, 'a')),
        ),
      ),
    )
    .orderBy(desc(battles.createdAt));

  const tally = new Map<string, OpponentRecord & { harnessId: string }>();
  for (const row of rows) {
    const opponentId = row.opponentHarnessId;
    if (!opponentId || opponentId === subject.id) continue;
    const entry = tally.get(opponentId) ?? {
      harnessId: opponentId,
      slug: '',
      name: '',
      battles: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      inconclusive: 0,
      lastBattleAt: null,
    };
    if (row.winner === 'tie') {
      entry.ties += 1;
      entry.battles += 1;
    } else if (row.winner === 'a' || row.winner === 'b') {
      if (row.winner === row.subjectSide) entry.wins += 1;
      else entry.losses += 1;
      entry.battles += 1;
    } else entry.inconclusive += 1;
    if (!entry.lastBattleAt) entry.lastBattleAt = row.createdAt.toISOString();
    tally.set(opponentId, entry);
  }
  if (tally.size === 0) return [];

  const names = await db
    .select({ id: harnesses.id, slug: harnesses.slug, name: harnesses.name })
    .from(harnesses)
    .where(inArray(harnesses.id, [...tally.keys()]));

  return [...tally.values()]
    .map((entry) => {
      const harness = names.find((row) => row.id === entry.harnessId);
      return {
        slug: harness?.slug ?? entry.harnessId,
        name: harness?.name ?? entry.harnessId,
        battles: entry.battles,
        wins: entry.wins,
        losses: entry.losses,
        ties: entry.ties,
        inconclusive: entry.inconclusive,
        lastBattleAt: entry.lastBattleAt,
      };
    })
    .sort((a, b) => b.battles - a.battles || b.wins - a.wins || a.slug.localeCompare(b.slug))
    .slice(0, Math.min(Math.max(limit, 1), 50));
}
