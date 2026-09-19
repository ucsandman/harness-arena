import {
  METRIC_DIRECTION,
  METRIC_KEYS,
  METRIC_LABELS,
  type MetricKey,
  type MetricValue,
  type RunMetrics,
} from '@harness-arena/protocol';
import { NOT_AVAILABLE, formatDuration, formatNumber, formatTokens, formatUsd } from './format';

export type MetricGroupId = 'outcome' | 'efficiency' | 'tokens' | 'work' | 'friction';

export interface MetricGroup {
  id: MetricGroupId;
  label: string;
  /** one-line explanation shown under the group heading */
  hint: string;
  keys: readonly MetricKey[];
}

/**
 * Curated presentation order. Outcome first (did the task get done), then the cost of getting there,
 * then the detail. Every key in METRIC_KEYS appears exactly once (asserted in test/metrics.test.ts).
 */
export const METRIC_GROUPS: readonly MetricGroup[] = [
  {
    id: 'outcome',
    label: 'Outcome',
    hint: 'Did the run finish and does the repository still work.',
    keys: ['completion_status', 'tests_passed', 'tests_failed', 'tests_total', 'regressions', 'exit_code'],
  },
  {
    id: 'efficiency',
    label: 'Efficiency',
    hint: 'What the result cost in time, tokens and model calls.',
    keys: ['duration_ms', 'tokens_total', 'cost_usd', 'model_requests', 'turns'],
  },
  {
    id: 'tokens',
    label: 'Token detail',
    hint: 'Only as precise as the CLI reports it.',
    keys: ['tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_write'],
  },
  {
    id: 'work',
    label: 'Work done',
    hint: 'Observable actions in the workspace.',
    keys: [
      'tool_calls',
      'commands_run',
      'files_inspected',
      'files_changed',
      'lines_added',
      'lines_removed',
      'subagents_spawned',
    ],
  },
  {
    id: 'friction',
    label: 'Friction',
    hint: 'Everything that got in the way.',
    keys: ['errors', 'retries', 'human_interventions', 'context_compactions'],
  },
];

/** Flat curated row order used by MetricsTable. */
export const METRIC_ROWS: readonly MetricKey[] = METRIC_GROUPS.flatMap((g) => g.keys);

/** The handful shown in the summary strip above the report. */
export const HEADLINE_METRIC_KEYS: readonly MetricKey[] = [
  'duration_ms',
  'tokens_total',
  'cost_usd',
  'files_changed',
  'tests_passed',
];

export function metricLabel(key: MetricKey): string {
  return METRIC_LABELS[key];
}

export function metricGroupOf(key: MetricKey): MetricGroup | undefined {
  return METRIC_GROUPS.find((g) => (g.keys as readonly string[]).includes(key));
}

export function isAvailable(metric: MetricValue | undefined): boolean {
  return !!metric && metric.status !== 'unavailable' && metric.value !== null;
}

/** Display string for a metric. Unavailable always renders as n/a, never 0. */
export function formatMetric(key: MetricKey, metric: MetricValue | undefined): string {
  if (!isAvailable(metric) || !metric) return NOT_AVAILABLE;
  const { value } = metric;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (typeof value !== 'number') return NOT_AVAILABLE;
  if (key === 'duration_ms') return formatDuration(value);
  if (key === 'cost_usd') return formatUsd(value);
  if (key.startsWith('tokens_')) return formatTokens(value);
  return formatNumber(value);
}

/** Unit suffix for screen readers and tooltips; the formatted value already carries the visual unit. */
export function metricUnit(key: MetricKey, metric: MetricValue | undefined): string | null {
  if (metric?.unit) return metric.unit;
  if (key === 'duration_ms') return 'minutes:seconds';
  if (key === 'cost_usd') return 'US dollars';
  if (key.startsWith('tokens_')) return 'tokens';
  return null;
}

export type BetterSide = 'a' | 'b' | 'equal' | 'n/a';

/**
 * Which side looks better for this metric. Returns 'n/a' unless both sides are known numbers and
 * the metric has a direction; a missing number is never treated as a zero.
 */
export function betterSide(
  key: MetricKey,
  a: MetricValue | undefined,
  b: MetricValue | undefined,
): BetterSide {
  const direction = METRIC_DIRECTION[key];
  if (direction === 'none') return 'n/a';
  if (!isAvailable(a) || !isAvailable(b)) return 'n/a';
  const av = a?.value;
  const bv = b?.value;
  if (typeof av !== 'number' || typeof bv !== 'number') return 'n/a';
  if (av === bv) return 'equal';
  const aWins = direction === 'lower' ? av < bv : av > bv;
  return aWins ? 'a' : 'b';
}

/** Relative gap between two sides for a metric, as a fraction of the larger value. */
export function metricGap(a: MetricValue | undefined, b: MetricValue | undefined): number | null {
  if (!isAvailable(a) || !isAvailable(b)) return null;
  const av = a?.value;
  const bv = b?.value;
  if (typeof av !== 'number' || typeof bv !== 'number') return null;
  const max = Math.max(Math.abs(av), Math.abs(bv));
  if (max === 0) return 0;
  return Math.abs(av - bv) / max;
}

export interface MetricRow {
  key: MetricKey;
  label: string;
  group: MetricGroupId;
  a: MetricValue | undefined;
  b: MetricValue | undefined;
  aText: string;
  bText: string;
  better: BetterSide;
  direction: 'lower' | 'higher' | 'none';
}

/** Build the table rows in curated order, dropping rows that are unavailable on both sides. */
export function buildMetricRows(
  a: RunMetrics | Partial<RunMetrics>,
  b: RunMetrics | Partial<RunMetrics>,
  options: { keys?: readonly MetricKey[]; hideDoubleUnavailable?: boolean } = {},
): MetricRow[] {
  const keys = options.keys ?? METRIC_ROWS;
  const rows: MetricRow[] = [];
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (options.hideDoubleUnavailable && !isAvailable(av) && !isAvailable(bv)) continue;
    rows.push({
      key,
      label: METRIC_LABELS[key],
      group: metricGroupOf(key)?.id ?? 'work',
      a: av,
      b: bv,
      aText: formatMetric(key, av),
      bText: formatMetric(key, bv),
      better: betterSide(key, av, bv),
      direction: METRIC_DIRECTION[key],
    });
  }
  return rows;
}

export const ALL_METRIC_KEYS: readonly MetricKey[] = METRIC_KEYS;

export const METRIC_STATUS_TEXT: Record<string, string> = {
  observed: 'Observed: reported directly by the agent CLI.',
  calculated: 'Calculated: derived by Arena from observed data.',
  estimated: 'Estimated: a labeled heuristic, not a measurement.',
  unavailable: 'Unavailable: this CLI does not report it. Shown as n/a, never 0.',
};
