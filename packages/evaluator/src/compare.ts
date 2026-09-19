import type {
  Comparison,
  Evidence,
  EvaluatorResult,
  MetricKey,
  MetricValue,
  RunMetrics,
} from '@harness-arena/protocol';
import { METRIC_DIRECTION, METRIC_KEYS, METRIC_LABELS, unavailable } from '@harness-arena/protocol';
import { assertionsViewFor } from './details.js';

/** Differences in these metrics can decide a winner. */
export const DECISIVE_METRIC_KEYS: readonly MetricKey[] = [
  'tests_failed',
  'regressions',
  'completion_status',
];
/** Differences in these metrics are worth showing prominently but never decide a winner. */
export const NOTABLE_METRIC_KEYS: readonly MetricKey[] = ['duration_ms', 'tokens_total', 'cost_usd', 'turns'];
/** How far apart two efficiency numbers must be before the difference is called notable. */
export const NOTABLE_RELATIVE_THRESHOLD = 0.15;

export function relativeDifference(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

function metricOf(metrics: RunMetrics, key: MetricKey): MetricValue {
  return metrics[key] ?? unavailable('metric was not reported');
}

/**
 * Pairs every protocol metric for both sides. A side is only called "better" when both values are real
 * numbers, neither is unavailable, and the metric has a direction; anything else is `n/a`, never a
 * silent zero.
 */
export function compareMetrics(a: RunMetrics, b: RunMetrics): Comparison[] {
  return METRIC_KEYS.map<Comparison>((key) => {
    const av = metricOf(a, key);
    const bv = metricOf(b, key);
    const direction = METRIC_DIRECTION[key];
    const known = av.status !== 'unavailable' && bv.status !== 'unavailable';
    const numeric = typeof av.value === 'number' && typeof bv.value === 'number';
    const comparable = known && numeric && direction !== 'none';

    let better: Comparison['better'] = 'n/a';
    if (comparable) {
      const an = av.value as number;
      const bn = bv.value as number;
      if (an === bn) better = 'equal';
      else if (direction === 'lower') better = an < bn ? 'a' : 'b';
      else better = an > bn ? 'a' : 'b';
    }

    const differs = av.value !== bv.value;
    let significance: Comparison['significance'] = 'minor';
    if (av.status === 'unavailable' && bv.status === 'unavailable') significance = 'none';
    else if (DECISIVE_METRIC_KEYS.includes(key) && known && differs) significance = 'decisive';
    else if (
      NOTABLE_METRIC_KEYS.includes(key) &&
      comparable &&
      relativeDifference(av.value as number, bv.value as number) >= NOTABLE_RELATIVE_THRESHOLD
    ) {
      significance = 'notable';
    }

    return { key, label: METRIC_LABELS[key], a: av, b: bv, better, significance };
  });
}

function favorsOf(better: Comparison['better']): Evidence['favors'] {
  return better === 'n/a' ? 'none' : better;
}

/** One evidence row per decisive or notable comparison, plus one per assertion that ran on both sides. */
export function buildEvidence(
  comparisons: readonly Comparison[],
  results: readonly EvaluatorResult[],
): Evidence[] {
  const evidence: Evidence[] = [];
  for (const comparison of comparisons) {
    if (comparison.significance !== 'decisive' && comparison.significance !== 'notable') continue;
    evidence.push({
      label: comparison.label,
      a: comparison.a.value,
      b: comparison.b.value,
      favors: favorsOf(comparison.better),
    });
  }

  const aView = assertionsViewFor(results, 'a');
  const bView = assertionsViewFor(results, 'b');
  if (aView || bView) {
    const indexes = [
      ...new Set([...(aView?.checks ?? []), ...(bView?.checks ?? [])].map((c) => c.index)),
    ].sort((x, y) => x - y);
    for (const index of indexes) {
      const aCheck = aView?.checks.find((c) => c.index === index);
      const bCheck = bView?.checks.find((c) => c.index === index);
      const label = aCheck?.label ?? bCheck?.label ?? `assertion ${index + 1}`;
      const aPassed = aCheck?.passed ?? null;
      const bPassed = bCheck?.passed ?? null;
      let favors: Evidence['favors'] = 'none';
      if (aPassed !== null && bPassed !== null) {
        if (aPassed === bPassed) favors = 'equal';
        else favors = aPassed ? 'a' : 'b';
      }
      evidence.push({
        label: `Assertion: ${label}`,
        a: aPassed === null ? null : aPassed ? 'passed' : 'failed',
        b: bPassed === null ? null : bPassed ? 'passed' : 'failed',
        favors,
      });
    }
  }

  return evidence;
}
