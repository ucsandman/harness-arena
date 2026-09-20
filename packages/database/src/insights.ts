import type { RatingCategory } from '@harness-arena/protocol';
import { RATING_CATEGORY_LABELS } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import { getHarnessProfile } from './queries.js';

/**
 * Deterministic insights: sentences a reader could have derived from the profile numbers themselves.
 *
 * No model is involved, on purpose. Every sentence names the sample it rests on and ends with the
 * count, so "stronger at debugging" can never be read as a general claim; a difference under the
 * thresholds below produces no sentence at all rather than a hedged one. Same input, same output,
 * every time — which is also what makes these safe to cache and to diff between two versions.
 */

/** A category needs this many rated battles before it may be called a strength or a weakness. */
export const INSIGHT_MIN_CATEGORY_SAMPLE = 5;
/** Each of the two compared versions needs this many battles. */
export const INSIGHT_MIN_VERSION_SAMPLE = 3;
/** Efficiency ratios need this many battles where both sides reported the metric. */
export const INSIGHT_MIN_EFFICIENCY_SAMPLE = 5;
/** Percentage points a category's correctness rate must differ from overall to be worth a sentence. */
export const INSIGHT_CATEGORY_DELTA_POINTS = 10;

export type InsightKind = 'category_strength' | 'category_weakness' | 'version_delta' | 'efficiency';

export interface HarnessInsight {
  kind: InsightKind;
  text: string;
  support: {
    /** the comparable battles behind the sentence; the sentence ends with this number */
    n: number;
    category?: RatingCategory;
    deltaPoints?: number;
    ratio?: number;
    versions?: { latest: string; previous: string };
  };
}

function points(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function shortCommit(commit: string | null, fallback: string): string {
  return commit ? commit.slice(0, 7) : fallback;
}

function sample(n: number): string {
  return `(${n} comparable battles)`;
}

/**
 * Insights for one harness, derived entirely from `getHarnessProfile`. Returns an empty list when
 * nothing clears the thresholds, which is the honest answer for a harness with three battles.
 */
export async function getHarnessInsights(
  db: ArenaDatabase,
  slug: string,
): Promise<{ insights: HarnessInsight[] }> {
  const profile = await getHarnessProfile(db, slug);
  if (!profile) return { insights: [] };

  const insights: HarnessInsight[] = [];
  const categories = profile.categoryPerformance;
  const overall = categories.find((entry) => entry.category === 'overall');

  // (a) category strengths and weaknesses, against this harness's own overall correctness rate
  if (overall && overall.correctnessRate !== null) {
    const baseline = overall.correctnessRate;
    const comparable = categories
      .filter(
        (entry) =>
          entry.category !== 'overall' &&
          entry.correctnessBattles >= INSIGHT_MIN_CATEGORY_SAMPLE &&
          entry.correctnessRate !== null,
      )
      .sort((a, b) => a.category.localeCompare(b.category));
    for (const entry of comparable) {
      const deltaPoints = ((entry.correctnessRate as number) - baseline) * 100;
      if (Math.abs(deltaPoints) < INSIGHT_CATEGORY_DELTA_POINTS) continue;
      const label = RATING_CATEGORY_LABELS[entry.category];
      insights.push({
        kind: deltaPoints > 0 ? 'category_strength' : 'category_weakness',
        text: `${label}: passes every correctness gate in ${percent(entry.correctnessRate as number)} of its battles, ${points(deltaPoints)} points against its ${percent(baseline)} overall ${sample(entry.correctnessBattles)}`,
        support: {
          n: entry.correctnessBattles,
          category: entry.category,
          deltaPoints: Math.round(deltaPoints),
        },
      });
    }
  }

  // (b) the change between the two most recent versions that both have enough battles
  const rated = profile.versions.filter((version) => version.battles >= INSIGHT_MIN_VERSION_SAMPLE);
  const latest = rated[0];
  const previous = rated[1];
  if (latest && previous) {
    const latestRate = latest.wins / latest.battles;
    const previousRate = previous.wins / previous.battles;
    const deltaPoints = (latestRate - previousRate) * 100;
    const n = latest.battles + previous.battles;
    const latestLabel = shortCommit(latest.commit, 'the current version');
    const previousLabel = shortCommit(previous.commit, 'the previous version');
    insights.push({
      kind: 'version_delta',
      text:
        Math.round(deltaPoints) === 0
          ? `Version ${latestLabel} wins ${percent(latestRate)} of its battles, the same as ${previousLabel} ${sample(n)}`
          : `Version ${latestLabel} wins ${percent(latestRate)} of its battles against ${percent(previousRate)} for ${previousLabel}, ${points(deltaPoints)} points ${sample(n)}`,
      support: {
        n,
        deltaPoints: Math.round(deltaPoints),
        versions: { latest: latestLabel, previous: previousLabel },
      },
    });
  }

  // (c) token efficiency against whoever it fought
  const tokens = profile.efficiencyProfile.find((entry) => entry.metric === 'tokens_total');
  if (tokens && tokens.median !== null && tokens.n >= INSIGHT_MIN_EFFICIENCY_SAMPLE) {
    const ratio = tokens.median;
    const deltaPercent = Math.round(Math.abs(ratio - 1) * 100);
    insights.push({
      kind: 'efficiency',
      text:
        deltaPercent === 0
          ? `Spends about the same tokens as its opponents: a median ratio of ${ratio.toFixed(2)}x ${sample(tokens.n)}`
          : `Spends ${deltaPercent}% ${ratio < 1 ? 'fewer' : 'more'} tokens than its opponents: a median ratio of ${ratio.toFixed(2)}x ${sample(tokens.n)}`,
      support: { n: tokens.n, ratio },
    });
  }

  return { insights };
}
