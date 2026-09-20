import { describe, expect, it } from 'vitest';
import type { EvaluationReport, EvaluatorResult, RunStatus, Side } from '@harness-arena/protocol';
import { calculated, emptyMetrics, observed } from '@harness-arena/protocol';
import { compareMetrics, decideVerdict } from '../src/index.js';
import {
  assertionsResult,
  buildResult,
  judgeResult,
  makeReport,
  metricsWith,
  testsResult,
} from './helpers.js';

const diffSignals: EvaluatorResult = {
  evaluatorId: 'diff-signals',
  kind: 'deterministic',
  side: 'a',
  status: 'passed',
  score: null,
  summary: '1 file(s), +2/-1',
  details: { filesChanged: 1, linesAdded: 2, linesRemoved: 1, signals: [] },
  durationMs: 0,
};

function sides(
  a: RunStatus = 'completed',
  b: RunStatus = 'completed',
): Record<Side, { status: RunStatus; metrics: ReturnType<typeof emptyMetrics> }> {
  return { a: { status: a, metrics: emptyMetrics() }, b: { status: b, metrics: emptyMetrics() } };
}

const allTestsPass = (side: Side, regressions = 0) =>
  testsResult(side, { passed: 4, failed: 0, total: 4, regressions, exitCode: 0 }, 'passed');

function efficiencyReport(results: EvaluatorResult[]): EvaluationReport {
  const comparisons = compareMetrics(
    metricsWith({ duration_ms: calculated(1000, 'core'), tokens_total: observed(10_000, 'cli') }),
    metricsWith({ duration_ms: calculated(2000, 'core'), tokens_total: observed(30_000, 'cli') }),
  );
  return makeReport(results, { comparisons });
}

describe('decideVerdict / completion', () => {
  it('the side that finished wins', () => {
    const verdict = decideVerdict(makeReport([diffSignals]), sides('completed', 'timed_out'));
    expect(verdict).toMatchObject({
      winner: 'a',
      confidence: 0.9,
      method: 'deterministic',
      decisiveFactors: ['completion'],
    });
    expect(verdict.reasons[0]).toContain('timed_out');
  });

  it('is inconclusive when neither side finished', () => {
    const verdict = decideVerdict(makeReport([diffSignals]), sides('failed', 'interrupted'));
    expect(verdict).toMatchObject({ winner: 'inconclusive', method: 'insufficient', confidence: 0.1 });
    expect(verdict.caveats.join(' ')).toContain('Neither side finished');
  });
});

describe('decideVerdict / tests', () => {
  it('passing tests beat failing tests', () => {
    const report = makeReport([
      allTestsPass('a'),
      testsResult('b', { passed: 3, failed: 1, total: 4, regressions: 1, exitCode: 1 }, 'failed'),
    ]);
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'a', confidence: 0.8, decisiveFactors: ['tests'] });
    expect(verdict.reasons[0]).toContain('4/4 passing');
  });

  it('uses the exit code when the parser reported no counts', () => {
    const report = makeReport([
      testsResult('a', { passed: null, failed: null, total: null, regressions: null, exitCode: 0 }, 'passed'),
      testsResult('b', { passed: null, failed: null, total: null, regressions: null, exitCode: 1 }, 'failed'),
    ]);
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'a', decisiveFactors: ['tests'] });
    expect(verdict.reasons[0]).toContain('exit 1');
  });

  it('regressions lose to no regressions even when both suites pass', () => {
    const report = makeReport([allTestsPass('a', 2), allTestsPass('b', 0)]);
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'b', confidence: 0.9, decisiveFactors: ['regressions'] });
    expect(verdict.reasons[0]).toContain('2 regression(s)');
  });
});

describe('decideVerdict / tests with missing evidence', () => {
  const noEvidence = (side: Side, exitCode: number | null) =>
    testsResult(side, { passed: null, failed: null, total: null, regressions: null, exitCode }, 'failed');

  it('does not crown a winner when the losing side produced no counts at all', () => {
    // side B's test command died (spawn error / killed): no counts, no exit code. That is missing
    // evidence, not a failing suite, so tests must not decide the battle.
    const verdict = decideVerdict(makeReport([allTestsPass('a'), noEvidence('b', null)]), sides());
    expect(verdict.winner).not.toBe('a');
    expect(verdict.winner).toBe('tie');
    expect(verdict.decisiveFactors).toEqual([]);
    expect(verdict.caveats.join(' ')).toContain("Side B's repository tests reported no pass/fail counts");
    expect(verdict.caveats.join(' ')).toContain('no exit code');
    expect(verdict.reasons.join(' ')).not.toContain('came out equal');
  });

  it('keeps the exit-code rule when both sides reported an exit code', () => {
    const report = makeReport([
      testsResult('a', { passed: null, failed: null, total: null, regressions: null, exitCode: 0 }, 'passed'),
      noEvidence('b', 1),
    ]);
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'a', decisiveFactors: ['tests'] });
    expect(verdict.caveats.join(' ')).not.toContain('no pass/fail counts');
  });

  it('does not use the exit-code rule when the other side has no exit code', () => {
    const report = makeReport([
      testsResult('a', { passed: null, failed: null, total: null, regressions: null, exitCode: 0 }, 'passed'),
      noEvidence('b', null),
    ]);
    const verdict = decideVerdict(report, sides());
    expect(verdict.winner).toBe('tie');
    expect(verdict.decisiveFactors).toEqual([]);
    expect(verdict.caveats.join(' ')).toContain("Side B's repository tests reported no pass/fail counts");
  });
});

describe('decideVerdict / assertions and build', () => {
  it('more satisfied assertions wins', () => {
    const report = makeReport([
      allTestsPass('a'),
      allTestsPass('b'),
      assertionsResult('a', 2, 3),
      assertionsResult('b', 3, 3),
    ]);
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'b', confidence: 0.7, decisiveFactors: ['assertions'] });
    expect(verdict.reasons[0]).toContain('3/3 task assertions');
  });

  it('passing build checks beat failing ones when everything above is equal', () => {
    const report = makeReport([
      allTestsPass('a'),
      allTestsPass('b'),
      assertionsResult('a', 3, 3),
      assertionsResult('b', 3, 3),
      buildResult('a', 2, 2),
      buildResult('b', 1, 2),
    ]);
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'a', confidence: 0.6, decisiveFactors: ['build'] });
    expect(verdict.reasons[0]).toContain('failed lint');
  });
});

function closeReport(results: EvaluatorResult[]): EvaluationReport {
  // 2% apart on every efficiency metric: under the 5% minimum, so efficiency must not decide.
  const comparisons = compareMetrics(
    metricsWith({
      duration_ms: calculated(1000, 'core'),
      tokens_total: observed(10_000, 'cli'),
      cost_usd: observed(1.0, 'cli'),
    }),
    metricsWith({
      duration_ms: calculated(1020, 'core'),
      tokens_total: observed(10_200, 'cli'),
      cost_usd: observed(1.02, 'cli'),
    }),
  );
  return makeReport(results, { comparisons });
}

describe('decideVerdict / efficiency tie-breaker', () => {
  it('breaks a clean tie on weighted efficiency and names every metric', () => {
    const verdict = decideVerdict(efficiencyReport([allTestsPass('a'), allTestsPass('b')]), sides());
    expect(verdict).toMatchObject({
      winner: 'a',
      method: 'deterministic',
      confidence: 0.55,
      decisiveFactors: ['efficiency'],
    });
    expect(verdict.reasons[0]).toContain('Both sides passed every correctness check');
    expect(verdict.reasons[0]).toContain('tokens A by 67%');
    expect(verdict.reasons[0]).toContain('duration A by 50%');
    expect(verdict.caveats.join(' ')).toContain('cost (not reported by both sides)');
    expect(verdict.breakdown.map((r) => `${r.factor}=${r.result}`)).toEqual([
      'completion=tie',
      'tests=tie',
      'regressions=tie',
      'assertions=n/a',
      'build=n/a',
      'efficiency=a',
    ]);
  });

  it('stays a tie when the weighted advantage is under the minimum', () => {
    const verdict = decideVerdict(closeReport([allTestsPass('a'), allTestsPass('b')]), sides());
    expect(verdict).toMatchObject({ winner: 'tie', confidence: 0.5, decisiveFactors: [] });
    expect(verdict.reasons[0]).toContain('efficiency did not separate them');
    expect(verdict.caveats.join(' ')).toContain('under the 5% minimum');
    expect(verdict.breakdown.at(-1)).toMatchObject({ factor: 'efficiency', result: 'tie' });
  });

  it('weights tokens 40, cost 35, time 25 so a big time win can lose to tokens plus cost', () => {
    // A: 25% fewer tokens, 56% cheaper. B: 33% faster. Weighted: 0.4*0.25 + 0.35*0.56 - 0.25*0.33 > 0.
    const comparisons = compareMetrics(
      metricsWith({
        duration_ms: calculated(292_000, 'core'),
        tokens_total: observed(311_400, 'cli'),
        cost_usd: observed(2.81, 'cli'),
      }),
      metricsWith({
        duration_ms: calculated(197_000, 'core'),
        tokens_total: observed(412_000, 'cli'),
        cost_usd: observed(6.42, 'cli'),
      }),
    );
    const report = makeReport([allTestsPass('a'), allTestsPass('b')], { comparisons });
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'a', decisiveFactors: ['efficiency'] });
    expect(verdict.reasons[0]).toContain('duration B by 33%');
  });

  it('never rewards a larger test count when both suites pass', () => {
    const report = closeReport([
      testsResult('a', { passed: 9, failed: 0, total: 9, regressions: 0, exitCode: 0 }, 'passed'),
      allTestsPass('b'),
    ]);
    expect(decideVerdict(report, sides()).winner).toBe('tie');
  });

  it('is not consulted when one side produced no usable test evidence', () => {
    const noEvidence = testsResult(
      'b',
      { passed: null, failed: null, total: null, regressions: null, exitCode: null },
      'failed',
    );
    const verdict = decideVerdict(efficiencyReport([allTestsPass('a'), noEvidence]), sides());
    expect(verdict.winner).toBe('tie');
    expect(verdict.decisiveFactors).toEqual([]);
    expect(verdict.breakdown.at(-1)).toMatchObject({ factor: 'efficiency', result: 'n/a' });
  });

  it('never breaks a tie on an estimated metric', () => {
    const comparisons = compareMetrics(
      metricsWith({ cost_usd: { value: 1, status: 'estimated', source: 'core:pricing' } }),
      metricsWith({ cost_usd: { value: 9, status: 'estimated', source: 'core:pricing' } }),
    );
    const report = makeReport([allTestsPass('a'), allTestsPass('b')], { comparisons });
    const verdict = decideVerdict(report, sides());
    expect(verdict.winner).toBe('tie');
    expect(verdict.caveats.join(' ')).toContain('estimated, not observed');
  });
});

describe('decideVerdict / tie and inconclusive', () => {
  it('is inconclusive when no deterministic evaluator ran, and says what to add', () => {
    const verdict = decideVerdict(efficiencyReport([diffSignals]), sides());
    expect(verdict).toMatchObject({ winner: 'inconclusive', method: 'insufficient' });
    expect(verdict.caveats.join(' ')).toContain('evaluation.tests');
  });

  it('never picks a winner from efficiency metrics alone', () => {
    const verdict = decideVerdict(efficiencyReport([diffSignals]), sides());
    expect(['tie', 'inconclusive']).toContain(verdict.winner);
  });
});

describe('decideVerdict / confidence', () => {
  it('loses 0.1 for every deterministic evaluator that could not run', () => {
    const report = makeReport(
      [
        allTestsPass('a'),
        testsResult('b', { passed: 3, failed: 1, total: 4, regressions: 1, exitCode: 1 }, 'failed'),
      ],
      {
        unavailable: [
          { evaluatorId: 'assertions', reason: 'no task assertions configured' },
          { evaluatorId: 'build-checks', reason: 'no build commands configured' },
          { evaluatorId: 'judge', reason: 'judge is disabled' },
        ],
      },
    );
    const verdict = decideVerdict(report, sides());
    expect(verdict.confidence).toBeCloseTo(0.6, 5);
    expect(verdict.caveats.join(' ')).toContain('assertions (no task assertions configured)');
  });

  it('clamps confidence into 0.1..0.95', () => {
    const many = makeReport([diffSignals], {
      unavailable: [
        { evaluatorId: 'repo-tests', reason: 'x' },
        { evaluatorId: 'assertions', reason: 'y' },
        { evaluatorId: 'build-checks', reason: 'z' },
      ],
    });
    expect(decideVerdict(many, sides('completed', 'failed')).confidence).toBeCloseTo(0.6, 5);
    expect(decideVerdict(many, sides('failed', 'failed')).confidence).toBe(0.1);
  });
});

describe('decideVerdict / judge', () => {
  it('never overrides a deterministic winner', () => {
    const report = makeReport([
      allTestsPass('a'),
      testsResult('b', { passed: 3, failed: 1, total: 4, regressions: 1, exitCode: 1 }, 'failed'),
      judgeResult('b', 0.9),
    ]);
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'a', method: 'deterministic', confidence: 0.8 });
    expect(verdict.judge).toMatchObject({ winner: 'b', blind: true, subjective: true });
    expect(verdict.caveats.join(' ')).toContain('deterministic result stands');
  });

  it('notes agreement without changing the winner', () => {
    const report = makeReport([
      allTestsPass('a'),
      testsResult('b', { passed: 3, failed: 1, total: 4, regressions: 1, exitCode: 1 }, 'failed'),
      judgeResult('a'),
    ]);
    const verdict = decideVerdict(report, sides());
    expect(verdict.winner).toBe('a');
    expect(verdict.caveats.join(' ')).toContain('agreed');
  });

  it('is reported alongside a tie without becoming the winner', () => {
    const report = closeReport([allTestsPass('a'), allTestsPass('b'), judgeResult('a', 0.7)]);
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'tie', method: 'deterministic+judge' });
    expect(verdict.judge?.winner).toBe('a');
    expect(verdict.caveats.join(' ')).toContain('does not set the winner');
  });

  it('is null when no judge ran', () => {
    expect(decideVerdict(makeReport([allTestsPass('a'), allTestsPass('b')]), sides()).judge).toBeNull();
  });
});

describe('decideVerdict / efficiency configuration', () => {
  const bothPass = [allTestsPass('a'), allTestsPass('b')];

  it('exposes the efficiency stage in full, with the configuration that produced it', () => {
    const verdict = decideVerdict(efficiencyReport(bothPass), sides());
    expect(verdict.efficiency).toMatchObject({ winner: 'a', minAdvantage: 0.05 });
    expect(verdict.efficiency?.metrics.map((m) => m.key).sort()).toEqual(['duration_ms', 'tokens_total']);
    expect(verdict.efficiency?.excluded).toEqual([{ key: 'cost_usd', reason: 'not reported by both sides' }]);
    expect(verdict.efficiency?.advantage).toBeGreaterThan(0.05);
  });

  it('reports the efficiency stage as n/a when a correctness gate decided the battle', () => {
    const verdict = decideVerdict(makeReport([diffSignals]), sides('completed', 'timed_out'));
    expect(verdict.efficiency).toMatchObject({ winner: 'n/a', advantage: 0, metrics: [], excluded: [] });
  });

  it('honours a custom minimum advantage', () => {
    const report = efficiencyReport(bothPass);
    const strict = decideVerdict(report, sides(), {
      efficiency: { weights: { tokens_total: 0.4, cost_usd: 0.35, duration_ms: 0.25 }, minAdvantage: 0.9 },
    });
    expect(strict.winner).toBe('tie');
    expect(strict.caveats.join(' ')).toContain('under the 90% minimum');
    expect(strict.efficiency).toMatchObject({ winner: 'tie', minAdvantage: 0.9 });
  });

  it('honours custom weights and drops a zero-weight metric from the comparison', () => {
    // A: 37% fewer tokens. B: 33% faster. With time weighted at 1 and tokens at 0, B wins.
    const comparisons = compareMetrics(
      metricsWith({ duration_ms: calculated(300_000, 'core'), tokens_total: observed(250_000, 'cli') }),
      metricsWith({ duration_ms: calculated(200_000, 'core'), tokens_total: observed(400_000, 'cli') }),
    );
    const report = makeReport(bothPass, { comparisons });
    const timeOnly = decideVerdict(report, sides(), {
      efficiency: { weights: { tokens_total: 0, cost_usd: 0, duration_ms: 1 }, minAdvantage: 0.05 },
    });
    expect(timeOnly).toMatchObject({ winner: 'b', decisiveFactors: ['efficiency'] });
    expect(timeOnly.efficiency?.metrics.map((m) => m.key)).toEqual(['duration_ms']);
    expect(timeOnly.efficiency?.excluded).toContainEqual({
      key: 'tokens_total',
      reason: 'weight is 0 in evaluation.efficiency',
    });
    expect(timeOnly.breakdown.at(-1)?.detail).toContain('duration 100%');

    const defaults = decideVerdict(report, sides());
    expect(defaults.winner).toBe('a');
  });
});
