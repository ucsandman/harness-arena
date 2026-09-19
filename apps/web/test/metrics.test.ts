import { describe, expect, it } from 'vitest';
import { METRIC_KEYS, emptyMetrics, type MetricValue } from '@harness-arena/protocol';
import {
  METRIC_GROUPS,
  METRIC_ROWS,
  betterSide,
  buildMetricRows,
  formatMetric,
  isAvailable,
  metricGap,
  metricGroupOf,
} from '../lib/metrics';
import { SAMPLE_RECORD } from '../lib/sample-battle';

const observed = (value: number): MetricValue => ({ value, status: 'observed', source: 'test' });
const missing: MetricValue = { value: null, status: 'unavailable', note: 'not reported' };

describe('metric row order', () => {
  it('includes every protocol metric key exactly once', () => {
    expect(new Set(METRIC_ROWS).size).toBe(METRIC_ROWS.length);
    expect([...METRIC_ROWS].sort()).toEqual([...METRIC_KEYS].sort());
  });

  it('assigns every key to a group', () => {
    for (const key of METRIC_KEYS) expect(metricGroupOf(key)).toBeDefined();
    expect(METRIC_GROUPS.map((group) => group.id)).toEqual([
      'outcome',
      'efficiency',
      'tokens',
      'work',
      'friction',
    ]);
  });
});

describe('formatMetric', () => {
  it('formats by metric kind', () => {
    expect(formatMetric('duration_ms', observed(274_100))).toBe('4:34');
    expect(formatMetric('tokens_total', observed(179_320))).toBe('179k');
    expect(formatMetric('cost_usd', observed(2.81))).toBe('$2.81');
    expect(formatMetric('files_changed', observed(3))).toBe('3');
    expect(formatMetric('completion_status', { value: 'completed', status: 'calculated' })).toBe('completed');
  });

  it('renders unavailable as n/a, never as zero', () => {
    expect(formatMetric('cost_usd', missing)).toBe('n/a');
    expect(formatMetric('cost_usd', undefined)).toBe('n/a');
    expect(isAvailable(missing)).toBe(false);
    expect(isAvailable(observed(0))).toBe(true);
    expect(formatMetric('tokens_total', observed(0))).toBe('0');
  });
});

describe('betterSide', () => {
  it('uses the protocol direction', () => {
    expect(betterSide('duration_ms', observed(100), observed(200))).toBe('a');
    expect(betterSide('tests_passed', observed(40), observed(43))).toBe('b');
    expect(betterSide('duration_ms', observed(100), observed(100))).toBe('equal');
  });

  it('never compares against a missing value and never ranks a directionless metric', () => {
    expect(betterSide('cost_usd', observed(2.81), missing)).toBe('n/a');
    expect(betterSide('cost_usd', missing, missing)).toBe('n/a');
    expect(betterSide('files_changed', observed(1), observed(9))).toBe('n/a');
  });

  it('measures the gap only when both sides are known', () => {
    expect(metricGap(observed(50), observed(100))).toBe(0.5);
    expect(metricGap(observed(0), observed(0))).toBe(0);
    expect(metricGap(observed(1), missing)).toBeNull();
  });
});

describe('buildMetricRows', () => {
  it('builds one row per curated key with formatted values', () => {
    const rows = buildMetricRows(SAMPLE_RECORD.runs.a.metrics, SAMPLE_RECORD.runs.b.metrics);
    expect(rows).toHaveLength(METRIC_ROWS.length);

    const cost = rows.find((row) => row.key === 'cost_usd');
    expect(cost?.aText).toBe('$2.81');
    expect(cost?.bText).toBe('n/a');
    expect(cost?.better).toBe('n/a');

    const failed = rows.find((row) => row.key === 'tests_failed');
    expect(failed?.better).toBe('a');
  });

  it('can drop rows that are unavailable on both sides', () => {
    const empty = emptyMetrics();
    const rows = buildMetricRows(empty, empty, { hideDoubleUnavailable: true });
    expect(rows).toHaveLength(0);
  });

  it('respects an explicit key subset', () => {
    const rows = buildMetricRows(SAMPLE_RECORD.runs.a.metrics, SAMPLE_RECORD.runs.b.metrics, {
      keys: ['duration_ms', 'cost_usd'],
    });
    expect(rows.map((row) => row.key)).toEqual(['duration_ms', 'cost_usd']);
  });
});
