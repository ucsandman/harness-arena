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

describe('decideVerdict / tie and inconclusive', () => {
  it('ties when deterministic evidence is equal, and names the efficiency gaps as caveats', () => {
    const verdict = decideVerdict(efficiencyReport([allTestsPass('a'), allTestsPass('b')]), sides());
    expect(verdict).toMatchObject({
      winner: 'tie',
      method: 'deterministic',
      confidence: 0.5,
      decisiveFactors: [],
    });
    const caveats = verdict.caveats.join('\n');
    expect(caveats).toContain('Side A was better on duration (1.0s vs 2.0s, 50% apart)');
    expect(caveats).toContain('efficiency does not decide the winner');
    expect(caveats).toContain('tokens');
  });

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
    const report = efficiencyReport([allTestsPass('a'), allTestsPass('b'), judgeResult('a', 0.7)]);
    const verdict = decideVerdict(report, sides());
    expect(verdict).toMatchObject({ winner: 'tie', method: 'deterministic+judge' });
    expect(verdict.judge?.winner).toBe('a');
    expect(verdict.caveats.join(' ')).toContain('does not set the winner');
  });

  it('is null when no judge ran', () => {
    expect(decideVerdict(makeReport([allTestsPass('a'), allTestsPass('b')]), sides()).judge).toBeNull();
  });
});
