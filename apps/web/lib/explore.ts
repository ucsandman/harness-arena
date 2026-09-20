import { RATING_MIN_SAMPLE, type RatingCategory, type RatingPool } from '@harness-arena/protocol';
import {
  getLeaderboard,
  getRatingHistory,
  type ArenaDatabase,
  type LeaderboardRow,
} from '@harness-arena/database';

/**
 * The numbers behind /explore.
 *
 * Everything here is derived from the two exported rating reads (`getLeaderboard`, `getRatingHistory`)
 * rather than new SQL, so the discovery page can never disagree with the leaderboard or with a
 * harness profile: it is the same audit trail, aggregated.
 *
 * "Rising" is the sum of the rating deltas recorded in `rating_events` inside the window. A rating
 * that did not move in the window contributes 0 and is left out, and the per-harness sample is
 * reported with the figure, because a +40 over 2 battles is not the same claim as +40 over 30.
 */

export const EXPLORE_RISING_DAYS = 30;
/** How many rated harnesses the rising list reads history for. Each one is a separate query. */
export const EXPLORE_RISING_SCAN = 25;

export interface ExploreFilter {
  agentId?: string;
  category: RatingCategory;
  pool: RatingPool;
  /** hide rows below this many decided battles; 0 shows everything */
  minBattles: number;
}

export interface RisingHarness {
  slug: string;
  name: string;
  /** rating points gained inside the window, summed over the events in it */
  delta: number;
  /** rating events inside the window: the sample behind `delta` */
  events: number;
  rating: number;
  battles: number;
  provisional: boolean;
}

export interface ExploreRankings {
  /** ranked first, provisional last: exactly the leaderboard's own order */
  top: LeaderboardRow[];
  mostTested: LeaderboardRow[];
  rising: RisingHarness[];
  /** how many rated rows the three lists were derived from */
  scanned: number;
  risingScanned: number;
}

function ranked(rows: readonly LeaderboardRow[], filter: ExploreFilter): LeaderboardRow[] {
  return rows.filter((row) => row.battles >= filter.minBattles);
}

export async function exploreRankings(
  db: ArenaDatabase,
  filter: ExploreFilter,
  limit = 8,
): Promise<ExploreRankings> {
  const rows = await getLeaderboard(db, {
    category: filter.category,
    pool: filter.pool,
    limit: 200,
    ...(filter.agentId ? { agentId: filter.agentId } : {}),
  });
  const visible = ranked(rows, filter);

  const mostTested = [...visible].sort((a, b) => b.battles - a.battles).slice(0, limit);

  // one harness may hold a rating per agent; the rising list is per harness, so the strongest row
  // carries the slug and the history query covers whatever agents the filter allows
  const bySlug = new Map<string, LeaderboardRow>();
  for (const row of visible) {
    const current = bySlug.get(row.harnessSlug);
    if (!current || row.rating > current.rating) bySlug.set(row.harnessSlug, row);
  }
  const candidates = [...bySlug.values()].sort((a, b) => b.battles - a.battles).slice(0, EXPLORE_RISING_SCAN);

  const since = Date.now() - EXPLORE_RISING_DAYS * 86_400_000;
  const rising: RisingHarness[] = [];
  for (const row of candidates) {
    const history = await getRatingHistory(db, row.harnessSlug, {
      category: filter.category,
      pool: filter.pool,
      limit: 200,
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
    });
    const inWindow = history.filter((point) => Date.parse(point.at) >= since);
    if (inWindow.length === 0) continue;
    const delta = inWindow.reduce((total, point) => total + point.delta, 0);
    if (delta <= 0) continue;
    rising.push({
      slug: row.harnessSlug,
      name: row.harnessName,
      delta: Math.round(delta * 10) / 10,
      events: inWindow.length,
      rating: row.rating,
      battles: row.battles,
      provisional: row.provisional,
    });
  }
  rising.sort((a, b) => b.delta - a.delta);

  return {
    top: visible.slice(0, limit),
    mostTested,
    rising: rising.slice(0, limit),
    scanned: rows.length,
    risingScanned: candidates.length,
  };
}

/** A rating below the minimum sample is never presented as "top"; the page labels it instead. */
export function isProvisionalSample(row: { battles: number; provisional: boolean }): boolean {
  return row.provisional || row.battles < RATING_MIN_SAMPLE;
}
