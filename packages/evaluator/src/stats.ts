import type { EvidenceStrength, MetricDelta, RateSummary, StatsSummary } from '@harness-arena/protocol';
import {
  STATS_HIGH_SAMPLE,
  STATS_LOW_SAMPLE,
  STATS_MEDIUM_SAMPLE,
  STATS_MIN_INTERVAL_SAMPLE,
} from '@harness-arena/protocol';

/**
 * Descriptive statistics over repeated runs: summaries, Wilson intervals, metric deltas, evidence
 * strength.
 *
 * Everything here is pure and every result carries the sample it came from, so no consumer can print
 * a single run as if it were a distribution. Intervals are the honest part: a mean of three runs gets
 * a t-interval wide enough to show it proves little, and a rate of 0/3 gets a Wilson interval that
 * still reaches past 0.5 instead of claiming a 0% failure rate.
 */

/** Two-sided 95% t values by degrees of freedom. Above df 30 the normal approximation is used. */
const T_95: Record<number, number> = {
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  11: 2.201,
  12: 2.179,
  13: 2.16,
  14: 2.145,
  15: 2.131,
  16: 2.12,
  17: 2.11,
  18: 2.101,
  19: 2.093,
  20: 2.086,
  21: 2.08,
  22: 2.074,
  23: 2.069,
  24: 2.064,
  25: 2.06,
  26: 2.056,
  27: 2.052,
  28: 2.048,
  29: 2.045,
  30: 2.042,
};

export const NORMAL_95 = 1.96;

export function tValue(df: number): number {
  return T_95[df] ?? NORMAL_95;
}

const EMPTY_SUMMARY: StatsSummary = {
  n: 0,
  mean: null,
  median: null,
  variance: null,
  stddev: null,
  min: null,
  max: null,
  ci95: null,
};

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Mean, median, sample variance and a t-based 95% interval for the mean. Non-finite values are dropped. */
export function summarize(values: number[]): StatsSummary {
  const finite = values.filter((value) => Number.isFinite(value));
  const n = finite.length;
  if (n === 0) return { ...EMPTY_SUMMARY };

  const sorted = [...finite].sort((x, y) => x - y);
  const mean = finite.reduce((sum, value) => sum + value, 0) / n;
  const variance = n < 2 ? null : finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const stddev = variance === null ? null : Math.sqrt(variance);

  let ci95: [number, number] | null = null;
  if (n >= STATS_MIN_INTERVAL_SAMPLE && stddev !== null) {
    const half = (tValue(n - 1) * stddev) / Math.sqrt(n);
    ci95 = [mean - half, mean + half];
  }

  return {
    n,
    mean,
    median: median(sorted),
    variance,
    stddev,
    min: sorted[0] as number,
    max: sorted[n - 1] as number,
    ci95,
  };
}

/**
 * A proportion with its Wilson score interval, which stays inside [0, 1] and stays wide on tiny
 * samples where the textbook normal interval collapses to a point.
 */
export function rate(successes: number, n: number): RateSummary {
  const hits = Math.max(0, successes);
  if (n < 1) return { n: 0, successes: hits, rate: null, ci95: null };

  const p = hits / n;
  const z = NORMAL_95;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const low = Math.max(0, center - margin);
  const high = Math.min(1, center + margin);
  return { n, successes: hits, rate: p, ci95: [low, high] };
}

/**
 * Control vs treatment on one metric. The inputs are paired — index i of both arrays is the same
 * task, trial or battle — so a missing value on either side removes the pair rather than shifting
 * every later comparison onto the wrong partner.
 */
export function metricDelta(control: number[], treatment: number[]): MetricDelta {
  if (control.length !== treatment.length) {
    throw new RangeError(
      `metricDelta expects paired inputs: control has ${control.length} values, treatment has ${treatment.length}`,
    );
  }

  const keptControl: number[] = [];
  const keptTreatment: number[] = [];
  for (let i = 0; i < control.length; i++) {
    const c = control[i] as number;
    const t = treatment[i] as number;
    if (!Number.isFinite(c) || !Number.isFinite(t)) continue;
    keptControl.push(c);
    keptTreatment.push(t);
  }

  const controlSummary = summarize(keptControl);
  const treatmentSummary = summarize(keptTreatment);
  const deltaPercent =
    controlSummary.mean === null || treatmentSummary.mean === null || controlSummary.mean === 0
      ? null
      : (treatmentSummary.mean - controlSummary.mean) / controlSummary.mean;

  return {
    control: controlSummary,
    treatment: treatmentSummary,
    deltaPercent,
    n: keptControl.length,
  };
}

/** How far a conclusion drawn from `n` comparable battles may be pushed. The sentence names `n`. */
export function evidenceStrength(n: number): EvidenceStrength {
  const battles = `${n} comparable battle${n === 1 ? '' : 's'}`;
  if (n >= STATS_HIGH_SAMPLE) {
    return {
      level: 'high',
      n,
      rationale: `${battles}: enough to state an effect size, not only a direction.`,
    };
  }
  if (n >= STATS_MEDIUM_SAMPLE) {
    return {
      level: 'medium',
      n,
      rationale: `${battles}: enough to see a consistent direction, not a precise effect size.`,
    };
  }
  if (n >= STATS_LOW_SAMPLE) {
    return {
      level: 'low',
      n,
      rationale: `${battles}: enough to describe this pair, not to generalise beyond it.`,
    };
  }
  return {
    level: 'none',
    n,
    rationale: `${battles} is below the ${STATS_LOW_SAMPLE} needed for even a weak conclusion.`,
  };
}
