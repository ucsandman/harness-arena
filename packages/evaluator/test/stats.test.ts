import { describe, expect, it } from 'vitest';
import { STATS_LOW_SAMPLE } from '@harness-arena/protocol';
import { evidenceStrength, metricDelta, NORMAL_95, rate, summarize, tValue } from '../src/index.js';

describe('summarize', () => {
  it('reports nothing it cannot compute', () => {
    expect(summarize([])).toEqual({
      n: 0,
      mean: null,
      median: null,
      variance: null,
      stddev: null,
      min: null,
      max: null,
      ci95: null,
    });
    expect(summarize([7])).toMatchObject({ n: 1, mean: 7, median: 7, min: 7, max: 7 });
    expect(summarize([7]).variance).toBeNull();
    expect(summarize([7]).ci95).toBeNull();
    expect(summarize([1, 2, Number.NaN, Number.POSITIVE_INFINITY]).n).toBe(2);
  });

  it('computes the textbook values for a known sample', () => {
    const s = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.n).toBe(8);
    expect(s.mean).toBeCloseTo(5, 10);
    expect(s.median).toBeCloseTo(4.5, 10);
    // sum of squared deviations is 32; the sample variance divides by n-1 = 7
    expect(s.variance).toBeCloseTo(32 / 7, 10);
    expect(s.stddev).toBeCloseTo(Math.sqrt(32 / 7), 10);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
  });

  it('opens a t interval exactly at three values, centred on the mean', () => {
    expect(summarize([1, 2]).ci95).toBeNull();
    const s = summarize([1, 2, 3]);
    expect(s.mean).toBeCloseTo(2, 10);
    expect(s.stddev).toBeCloseTo(1, 10);
    const half = 4.303 / Math.sqrt(3);
    expect(s.ci95?.[0]).toBeCloseTo(2 - half, 6);
    expect(s.ci95?.[1]).toBeCloseTo(2 + half, 6);
    expect((s.ci95 as [number, number])[0] + (s.ci95 as [number, number])[1]).toBeCloseTo(4, 6);
  });

  it('uses the t table up to df 30 and the normal beyond it', () => {
    expect(tValue(2)).toBe(4.303);
    expect(tValue(10)).toBe(2.228);
    expect(tValue(30)).toBe(2.042);
    expect(tValue(31)).toBe(NORMAL_95);
    expect(tValue(60)).toBe(1.96);
    // a wider interval on a smaller sample, with the same spread
    const small = summarize([9, 10, 11]);
    const large = summarize(Array.from({ length: 31 }, (_, i) => 9 + (i % 3)));
    const width = (s: ReturnType<typeof summarize>): number =>
      (s.ci95 as [number, number])[1] - (s.ci95 as [number, number])[0];
    expect(width(small)).toBeGreaterThan(width(large));
  });
});

describe('rate', () => {
  it('refuses to state a rate over no observations', () => {
    expect(rate(0, 0)).toEqual({ n: 0, successes: 0, rate: null, ci95: null });
  });

  it('is the Wilson score interval, which stays inside [0, 1]', () => {
    const seven = rate(7, 10);
    expect(seven.rate).toBeCloseTo(0.7, 10);
    expect(seven.ci95?.[0]).toBeCloseTo(0.3968, 3);
    expect(seven.ci95?.[1]).toBeCloseTo(0.8922, 3);
    expect(seven.ci95?.[0]).toBeLessThan(0.7);
    expect(seven.ci95?.[1]).toBeGreaterThan(0.7);

    const none = rate(0, 10);
    expect(none.rate).toBe(0);
    expect(none.ci95?.[0]).toBe(0);
    expect(none.ci95?.[1]).toBeGreaterThan(0);
    expect(none.ci95?.[1]).toBeLessThan(0.31);

    const all = rate(10, 10);
    expect(all.ci95?.[1]).toBe(1);
    expect(all.ci95?.[0]).toBeLessThan(1);

    // a perfect 3/3 must not read as certainty
    expect(rate(3, 3).ci95?.[0]).toBeLessThan(0.5);
  });
});

describe('metricDelta', () => {
  it('insists on paired inputs', () => {
    expect(() => metricDelta([1, 2], [1])).toThrow(RangeError);
  });

  it('drops a pair when either side is missing', () => {
    const delta = metricDelta([1, Number.NaN, 3], [2, 4, Number.POSITIVE_INFINITY]);
    expect(delta.n).toBe(1);
    expect(delta.control.n).toBe(1);
    expect(delta.treatment.n).toBe(1);
  });

  it('reports the relative change of the means', () => {
    expect(metricDelta([100, 100], [80, 120]).deltaPercent).toBeCloseTo(0, 10);
    expect(metricDelta([100, 100], [50, 50]).deltaPercent).toBeCloseTo(-0.5, 10);
    expect(metricDelta([100, 100], [150, 150]).deltaPercent).toBeCloseTo(0.5, 10);
    expect(metricDelta([0, 0], [1, 1]).deltaPercent).toBeNull();
    expect(metricDelta([], []).deltaPercent).toBeNull();
    expect(metricDelta([], []).n).toBe(0);
  });
});

describe('evidenceStrength', () => {
  it('names its sample in every rationale and moves at the documented thresholds', () => {
    const cases: [number, string][] = [
      [0, 'none'],
      [4, 'none'],
      [5, 'low'],
      [9, 'low'],
      [10, 'medium'],
      [29, 'medium'],
      [30, 'high'],
      [100, 'high'],
    ];
    for (const [n, level] of cases) {
      const evidence = evidenceStrength(n);
      expect({ n, level: evidence.level }).toEqual({ n, level });
      expect(evidence.n).toBe(n);
      expect(evidence.rationale).toContain(String(n));
    }
    expect(evidenceStrength(1).rationale).toContain('1 comparable battle ');
    expect(evidenceStrength(4).rationale).toContain(String(STATS_LOW_SAMPLE));
  });
});
