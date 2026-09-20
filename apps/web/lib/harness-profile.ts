import {
  getHarnessInsights,
  getHarnessProfile,
  getLineage,
  getUserById,
  listChallenges,
  listOpponents,
  type ArenaDatabase,
  type HarnessEfficiencyRatio,
} from '@harness-arena/database';
import { harnessProfileResponseSchema, type HarnessProfileResponse } from '@harness-arena/protocol';

/**
 * Assembles the /api/v1/harnesses/:slug response from five independent reads: the catalogue row and
 * battle history (`getHarnessProfile`), the harnesses actually fought (`listOpponents`), deterministic
 * insight sentences (`getHarnessInsights`), declared ancestry (`getLineage`) and the public challenge
 * count (`listChallenges`). Every number below already carries its sample from the query that produced
 * it (`n`, `battles`, `correctnessBattles`); this file only reshapes those numbers into the wire schema,
 * it never computes a new one.
 */

type EfficiencyMetric = HarnessEfficiencyRatio['metric'];

function toRatio(entry: HarnessEfficiencyRatio | undefined): { medianRatio: number | null; n: number } {
  if (!entry) return { medianRatio: null, n: 0 };
  return { medianRatio: entry.median, n: entry.n };
}

export async function buildHarnessProfileResponse(
  dbh: ArenaDatabase,
  slug: string,
): Promise<HarnessProfileResponse | null> {
  const profile = await getHarnessProfile(dbh, slug);
  if (!profile) return null;

  const [opponents, insightsResult, lineage, challenges, owner] = await Promise.all([
    listOpponents(dbh, slug, 10),
    getHarnessInsights(dbh, slug),
    getLineage(dbh, slug),
    listChallenges(dbh, { harnessSlug: slug, limit: 50 }),
    profile.harness.ownerUserId ? getUserById(dbh, profile.harness.ownerUserId) : null,
  ]);

  const byMetric = new Map<EfficiencyMetric, HarnessEfficiencyRatio>(
    profile.efficiencyProfile.map((entry) => [entry.metric, entry]),
  );

  return harnessProfileResponseSchema.parse({
    slug: profile.harness.slug,
    name: profile.harness.name,
    sourceUrl: profile.harness.sourceUrl,
    sourceKind: profile.harness.sourceKind,
    description: profile.harness.description,
    framework: profile.harness.framework,
    owner: owner?.login ?? null,
    ratings: profile.ratings.map((rating) => ({
      agentId: rating.agentId,
      category: rating.category,
      pool: rating.pool,
      rating: rating.rating,
      deviation: rating.deviation,
      peakRating: rating.peakRating,
      battles: rating.battles,
      wins: rating.wins,
      losses: rating.losses,
      ties: rating.ties,
      provisional: rating.provisional,
      form: rating.form,
      lastBattleAt: rating.lastBattleAt ? rating.lastBattleAt.toISOString() : null,
    })),
    versions: profile.versions.map((version) => ({
      id: version.id,
      commit: version.commit,
      createdAt: version.createdAt.toISOString(),
      battles: version.battles,
      wins: version.wins,
      losses: version.losses,
      ties: version.ties,
    })),
    categoryPerformance: profile.categoryPerformance,
    efficiencyProfile: {
      tokens: toRatio(byMetric.get('tokens_total')),
      cost: toRatio(byMetric.get('cost_usd')),
      duration: toRatio(byMetric.get('duration_ms')),
    },
    recentBattles: profile.recentBattles,
    opponents: opponents.map((opponent) => ({
      slug: opponent.slug,
      name: opponent.name,
      wins: opponent.wins,
      losses: opponent.losses,
      ties: opponent.ties,
    })),
    lineage: lineage ?? { ancestors: [], descendants: [] },
    insights: insightsResult.insights.map((insight) => ({
      kind: insight.kind,
      text: insight.text,
      n: insight.support.n,
    })),
    challenges: challenges.length,
    analyzedBattles: profile.analyzedBattles,
  });
}
