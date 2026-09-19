import type {
  Comparison,
  EvaluationReport,
  MetricKey,
  RunMetrics,
  RunStatus,
  Side,
  Verdict,
} from '@harness-arena/protocol';
import { assertionsViewFor, buildChecksViewFor, judgeOpinionOf, testsViewFor } from './details.js';
import type { TestsView } from './details.js';
import { DETERMINISTIC_EVALUATOR_IDS } from './evaluators/index.js';
import { relativeDifference } from './compare.js';

/** Confidence a decisive factor is worth before penalties. */
export const FACTOR_CONFIDENCE: Record<string, number> = {
  completion: 0.9,
  regressions: 0.9,
  tests: 0.8,
  assertions: 0.7,
  build: 0.6,
};
export const CONFIDENCE_MIN = 0.1;
export const CONFIDENCE_MAX = 0.95;
/** Each deterministic evaluator that could not run costs this much confidence. */
export const UNAVAILABLE_PENALTY = 0.1;

const EFFICIENCY_KEYS: readonly MetricKey[] = ['duration_ms', 'tokens_total', 'cost_usd'];

export interface VerdictSideInput {
  status: RunStatus;
  metrics: RunMetrics;
}

function label(side: Side): string {
  return side === 'a' ? 'A' : 'B';
}

function other(side: Side): Side {
  return side === 'a' ? 'b' : 'a';
}

function clamp(value: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, Number(value.toFixed(4))));
}

function formatMetric(key: MetricKey, value: unknown): string {
  if (typeof value !== 'number') return String(value);
  if (key === 'duration_ms') return `${(value / 1000).toFixed(1)}s`;
  if (key === 'cost_usd') return `$${value.toFixed(4)}`;
  return String(value);
}

interface DeterministicOutcome {
  winner: Verdict['winner'];
  method: Verdict['method'];
  reasons: string[];
  decisiveFactors: string[];
  caveats: string[];
}

function testsRan(view: TestsView | null): view is TestsView {
  return view !== null && view.status !== 'skipped' && view.status !== 'error';
}

function testsAllPassed(view: TestsView): boolean {
  return view.failed === 0 && (view.passed ?? 0) > 0;
}

function testsHaveFailures(view: TestsView): boolean {
  if (view.failed !== null) return view.failed > 0;
  return view.status === 'failed';
}

/** Efficiency never decides a winner; it is reported as a caveat so nobody reads a tie as "identical". */
function efficiencyCaveats(comparisons: readonly Comparison[]): string[] {
  const caveats: string[] = [];
  for (const comparison of comparisons) {
    if (!EFFICIENCY_KEYS.includes(comparison.key)) continue;
    if (comparison.better !== 'a' && comparison.better !== 'b') continue;
    const percent = Math.round(
      relativeDifference(comparison.a.value as number, comparison.b.value as number) * 100,
    );
    caveats.push(
      `Side ${label(comparison.better)} was better on ${comparison.label.toLowerCase()} ` +
        `(${formatMetric(comparison.key, comparison.a.value)} vs ${formatMetric(comparison.key, comparison.b.value)}, ` +
        `${percent}% apart); efficiency does not decide the winner.`,
    );
  }
  return caveats;
}

function decideDeterministic(
  report: EvaluationReport,
  sides: Record<Side, VerdictSideInput>,
): DeterministicOutcome {
  const results = report.results;

  // 1. Completion.
  const completed: Record<Side, boolean> = {
    a: sides.a.status === 'completed',
    b: sides.b.status === 'completed',
  };
  if (completed.a !== completed.b) {
    const winner: Side = completed.a ? 'a' : 'b';
    const loser = other(winner);
    return {
      winner,
      method: 'deterministic',
      decisiveFactors: ['completion'],
      reasons: [
        `Side ${label(winner)} completed its run while side ${label(loser)} ended as ${sides[loser].status}.`,
      ],
      caveats: [],
    };
  }
  if (!completed.a && !completed.b) {
    return {
      winner: 'inconclusive',
      method: 'insufficient',
      decisiveFactors: [],
      reasons: [`Neither run completed (side A: ${sides.a.status}, side B: ${sides.b.status}).`],
      caveats: ['Neither side finished, so there is nothing to compare.'],
    };
  }

  // 2. Repository tests, then regressions.
  const aTests = testsViewFor(results, 'a');
  const bTests = testsViewFor(results, 'b');
  const bothTests = testsRan(aTests) && testsRan(bTests);
  if (bothTests && aTests && bTests) {
    for (const side of ['a', 'b'] as const) {
      const mine = side === 'a' ? aTests : bTests;
      const theirs = side === 'a' ? bTests : aTests;
      // Counts decide when the parser produced them; otherwise the evaluator status (which is the
      // exit code for the `exit-code` parser) is still deterministic evidence.
      const byCounts = testsAllPassed(mine) && testsHaveFailures(theirs);
      const byStatus = mine.status === 'passed' && theirs.status === 'failed';
      if (byCounts || byStatus) {
        const reason = byCounts
          ? `Side ${label(side)} passed the repository tests (${mine.passed}/${mine.total ?? mine.passed} passing) ` +
            `while side ${label(other(side))} had ${theirs.failed ?? 'failing'} failing test(s).`
          : `Side ${label(side)}'s test command succeeded (exit ${mine.exitCode ?? 'unknown'}) while side ` +
            `${label(other(side))}'s did not (exit ${theirs.exitCode ?? 'unknown'}).`;
        return {
          winner: side,
          method: 'deterministic',
          decisiveFactors: ['tests'],
          reasons: [reason],
          caveats: [],
        };
      }
    }
    const aReg = aTests.regressions;
    const bReg = bTests.regressions;
    if (aReg !== null && bReg !== null && aReg !== bReg) {
      if (aReg > 0 && bReg === 0) {
        return {
          winner: 'b',
          method: 'deterministic',
          decisiveFactors: ['regressions'],
          reasons: [`Side A introduced ${aReg} regression(s); side B introduced none.`],
          caveats: [],
        };
      }
      if (bReg > 0 && aReg === 0) {
        return {
          winner: 'a',
          method: 'deterministic',
          decisiveFactors: ['regressions'],
          reasons: [`Side B introduced ${bReg} regression(s); side A introduced none.`],
          caveats: [],
        };
      }
    }
  }

  // 3. Assertions.
  const aAssert = assertionsViewFor(results, 'a');
  const bAssert = assertionsViewFor(results, 'b');
  const bothAssert = aAssert !== null && bAssert !== null && aAssert.total > 0;
  if (bothAssert && aAssert && bAssert && aAssert.passed !== bAssert.passed) {
    const winner: Side = aAssert.passed > bAssert.passed ? 'a' : 'b';
    const winnerView = winner === 'a' ? aAssert : bAssert;
    const loserView = winner === 'a' ? bAssert : aAssert;
    return {
      winner,
      method: 'deterministic',
      decisiveFactors: ['assertions'],
      reasons: [
        `Side ${label(winner)} satisfied ${winnerView.passed}/${winnerView.total} task assertions, ` +
          `side ${label(other(winner))} satisfied ${loserView.passed}/${loserView.total}.`,
      ],
      caveats: [],
    };
  }

  // 4. Build / lint / typecheck.
  const aBuild = buildChecksViewFor(results, 'a');
  const bBuild = buildChecksViewFor(results, 'b');
  const bothBuild =
    aBuild !== null && bBuild !== null && aBuild.status !== 'skipped' && bBuild.status !== 'skipped';
  if (bothBuild && aBuild && bBuild) {
    const aOk = aBuild.status === 'passed';
    const bOk = bBuild.status === 'passed';
    if (aOk !== bOk) {
      const winner: Side = aOk ? 'a' : 'b';
      const loserView = aOk ? bBuild : aBuild;
      const failed = loserView.failedKinds.length ? loserView.failedKinds.join(', ') : 'checks';
      return {
        winner,
        method: 'deterministic',
        decisiveFactors: ['build'],
        reasons: [
          `Side ${label(winner)} passed every build check; side ${label(other(winner))} failed ${failed}.`,
        ],
        caveats: [],
      };
    }
  }

  // 5. Nothing separated the sides.
  if (!bothTests && !bothAssert && !bothBuild) {
    return {
      winner: 'inconclusive',
      method: 'insufficient',
      decisiveFactors: [],
      reasons: ['No deterministic evaluator produced a result for both sides.'],
      caveats: [
        'Add evaluation.tests (a test command) or evaluation.assertions to this battle to get a deterministic winner.',
      ],
    };
  }
  return {
    winner: 'tie',
    method: 'deterministic',
    decisiveFactors: [],
    reasons: ['Every deterministic check that ran came out equal for both sides.'],
    caveats: efficiencyCaveats(report.comparisons),
  };
}

function baseConfidence(outcome: DeterministicOutcome): number {
  for (const factor of outcome.decisiveFactors) {
    const value = FACTOR_CONFIDENCE[factor];
    if (value !== undefined) return value;
  }
  if (outcome.winner === 'tie') return 0.5;
  if (outcome.winner === 'inconclusive') return CONFIDENCE_MIN;
  return 0.5;
}

/**
 * Turns an evaluation report into a winner. Deterministic evidence decides, in a fixed order; the
 * optional judge is reported but can never override it; efficiency metrics never invent a winner.
 */
export function decideVerdict(report: EvaluationReport, sides: Record<Side, VerdictSideInput>): Verdict {
  const outcome = decideDeterministic(report, sides);
  const judge = judgeOpinionOf(report.results);

  const deterministicIds = DETERMINISTIC_EVALUATOR_IDS as readonly string[];
  const missing = report.unavailable.filter((entry) => deterministicIds.includes(entry.evaluatorId)).length;
  const confidence = clamp(baseConfidence(outcome) - missing * UNAVAILABLE_PENALTY);

  const caveats = [...outcome.caveats];
  let method = outcome.method;
  if (missing > 0) {
    const names = report.unavailable
      .filter((entry) => deterministicIds.includes(entry.evaluatorId))
      .map((entry) => `${entry.evaluatorId} (${entry.reason})`)
      .join('; ');
    caveats.push(`Deterministic evaluators that did not run: ${names}.`);
  }
  if (judge) {
    const preference =
      judge.winner === 'a' || judge.winner === 'b' ? `side ${label(judge.winner)}` : 'neither side';
    if (outcome.winner === 'tie' || outcome.winner === 'inconclusive') {
      method = 'deterministic+judge';
      caveats.push(
        `The blind judge (${judge.judgeAgent}) preferred ${preference} with confidence ${judge.confidence}. ` +
          'That opinion is subjective and does not set the winner.',
      );
    } else if (judge.winner === outcome.winner) {
      caveats.push(`The blind judge agreed with the deterministic winner (subjective, not counted).`);
    } else {
      caveats.push(
        `The blind judge preferred ${preference}, which deterministic evidence does not support; ` +
          'the deterministic result stands.',
      );
    }
  }

  return {
    winner: outcome.winner,
    confidence,
    method,
    reasons: outcome.reasons,
    decisiveFactors: outcome.decisiveFactors,
    caveats,
    judge,
  };
}
