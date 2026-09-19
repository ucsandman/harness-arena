import { describe, expect, it } from 'vitest';
import type { Comparison, MetricKey, MetricValue } from '@harness-arena/protocol';
import { METRIC_KEYS, calculated, emptyMetrics, observed, unavailable } from '@harness-arena/protocol';
import { buildEvidence, compareMetrics, relativeDifference } from '../src/index.js';
import { assertionsResult } from './helpers.js';

function comparison(key: MetricKey, a: MetricValue | null, b: MetricValue | null): Comparison {
  const metricsA = emptyMetrics();
  const metricsB = emptyMetrics();
  if (a) metricsA[key] = a;
  if (b) metricsB[key] = b;
  const found = compareMetrics(metricsA, metricsB).find((c) => c.key === key);
  if (!found) throw new Error(`no comparison for ${key}`);
  return found;
}

describe('relativeDifference', () => {
  it('is zero for equal values and safe at zero', () => {
    expect(relativeDifference(0, 0)).toBe(0);
    expect(relativeDifference(5, 5)).toBe(0);
    expect(relativeDifference(1000, 2000)).toBeCloseTo(0.5, 5);
  });
});

describe('compareMetrics', () => {
  it('produces exactly one comparison per protocol metric, in order', () => {
    const comparisons = compareMetrics(emptyMetrics(), emptyMetrics());
    expect(comparisons).toHaveLength(METRIC_KEYS.length);
    expect(comparisons.map((c) => c.key)).toEqual([...METRIC_KEYS]);
  });

  it('says n/a and none when both sides are unavailable', () => {
    const result = comparison('duration_ms', null, null);
    expect(result).toMatchObject({ better: 'n/a', significance: 'none' });
  });

  it('says n/a when only one side has a number', () => {
    const result = comparison('duration_ms', calculated(1000, 'core'), null);
    expect(result).toMatchObject({ better: 'n/a', significance: 'minor' });
  });

  it('respects the metric direction', () => {
    expect(comparison('duration_ms', calculated(1000, 'core'), calculated(2000, 'core')).better).toBe('a');
    expect(comparison('tests_passed', calculated(5, 'core'), calculated(3, 'core')).better).toBe('a');
    expect(comparison('tests_failed', calculated(2, 'core'), calculated(0, 'core')).better).toBe('b');
    expect(comparison('lines_added', calculated(2, 'core'), calculated(400, 'core')).better).toBe('n/a');
    expect(comparison('cost_usd', observed(0.5, 'cli'), observed(0.5, 'cli')).better).toBe('equal');
  });

  it('calls tests_failed, regressions and completion_status differences decisive', () => {
    expect(comparison('tests_failed', calculated(0, 'core'), calculated(2, 'core')).significance).toBe(
      'decisive',
    );
    expect(comparison('regressions', calculated(1, 'core'), calculated(0, 'core')).significance).toBe(
      'decisive',
    );
    const status = comparison('completion_status', observed('completed', 'core'), observed('failed', 'core'));
    expect(status).toMatchObject({ significance: 'decisive', better: 'n/a' });
    expect(comparison('tests_failed', calculated(1, 'core'), calculated(1, 'core')).significance).toBe(
      'minor',
    );
  });

  it('calls efficiency differences notable only at or above 15 percent', () => {
    expect(comparison('duration_ms', calculated(1000, 'core'), calculated(1050, 'core')).significance).toBe(
      'minor',
    );
    expect(comparison('duration_ms', calculated(1000, 'core'), calculated(1200, 'core')).significance).toBe(
      'notable',
    );
    expect(comparison('tokens_total', observed(10_000, 'cli'), observed(30_000, 'cli')).significance).toBe(
      'notable',
    );
    expect(comparison('cost_usd', observed(1, 'cli'), observed(1.1, 'cli')).significance).toBe('minor');
    expect(comparison('turns', observed(4, 'cli'), observed(9, 'cli')).significance).toBe('notable');
    expect(comparison('tool_calls', observed(4, 'cli'), observed(90, 'cli')).significance).toBe('minor');
  });

  it('never invents a number for an unavailable metric', () => {
    const result = comparison('cost_usd', unavailable('codex does not report cost'), observed(0.42, 'cli'));
    expect(result.a.value).toBeNull();
    expect(result.a.status).toBe('unavailable');
    expect(result.better).toBe('n/a');
  });
});

describe('buildEvidence', () => {
  it('includes decisive and notable comparisons plus assertion rows', () => {
    const comparisons = [
      comparison('tests_failed', calculated(0, 'core'), calculated(2, 'core')),
      comparison('duration_ms', calculated(1000, 'core'), calculated(2000, 'core')),
      comparison('tool_calls', observed(4, 'cli'), observed(90, 'cli')),
    ];
    const evidence = buildEvidence(comparisons, [assertionsResult('a', 2, 3), assertionsResult('b', 3, 3)]);
    const labels = evidence.map((e) => e.label);
    expect(labels).toContain('Tests failed');
    expect(labels).toContain('Duration');
    expect(labels).not.toContain('Tool calls');
    expect(evidence.find((e) => e.label === 'Tests failed')?.favors).toBe('a');
    expect(evidence.filter((e) => e.label.startsWith('Assertion:'))).toHaveLength(3);
    const third = evidence.find((e) => e.label === 'Assertion: assertion 3');
    expect(third).toMatchObject({ a: 'failed', b: 'passed', favors: 'b' });
    const first = evidence.find((e) => e.label === 'Assertion: assertion 1');
    expect(first).toMatchObject({ a: 'passed', b: 'passed', favors: 'equal' });
  });

  it('is empty when nothing is decisive, notable or asserted', () => {
    expect(buildEvidence([comparison('tool_calls', observed(4, 'cli'), observed(5, 'cli'))], [])).toEqual([]);
  });
});
