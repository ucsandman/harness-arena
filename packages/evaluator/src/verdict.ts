import type {
  Comparison,
  EfficiencyConfig,
  EfficiencyMetricKey,
  EvaluationReport,
  MetricKey,
  RunMetrics,
  RunStatus,
  Side,
  Verdict,
  VerdictBreakdownRow,
  VerdictEfficiency,
} from '@harness-arena/protocol';
import { DEFAULT_EFFICIENCY_CONFIG, EFFICIENCY_METRIC_KEYS, METRIC_LABELS } from '@harness-arena/protocol';
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
  efficiency: 0.55,
};
export const CONFIDENCE_MIN = 0.1;
export const CONFIDENCE_MAX = 0.95;
/** Each deterministic evaluator that could not run costs this much confidence. */
export const UNAVAILABLE_PENALTY = 0.1;

/**
 * Efficiency breaks a tie between two sides that are equally correct, and only then. Weights are
 * renormalised over the metrics both sides actually reported; a metric one side did not report
 * contributes nothing rather than a silent zero. These are the defaults; a battle spec overrides them
 * through `evaluation.efficiency`.
 */
export const EFFICIENCY_WEIGHTS: Readonly<Record<EfficiencyMetricKey, number>> =
  DEFAULT_EFFICIENCY_CONFIG.weights;
/** The weighted relative advantage a side needs before efficiency is allowed to name it the winner. */
export const EFFICIENCY_MIN_ADVANTAGE = DEFAULT_EFFICIENCY_CONFIG.minAdvantage;

export interface DecideVerdictOptions {
  efficiency?: EfficiencyConfig;
}

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

function percentText(value: number): string {
  return `${Math.round(value * 100)}%`;
}

interface DeterministicOutcome {
  winner: Verdict['winner'];
  method: Verdict['method'];
  reasons: string[];
  decisiveFactors: string[];
  caveats: string[];
  breakdown: VerdictBreakdownRow[];
  efficiency: VerdictEfficiency;
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

/**
 * Did the parser produce any pass/fail counts for this side? A side with no counts at all (spawn error,
 * a timed-out test command, or the `exit-code` parser) is missing evidence, not proof of failure.
 */
function testCountsKnown(view: TestsView): boolean {
  return view.passed !== null || view.failed !== null;
}

export interface EfficiencyOutcome {
  winner: Side | 'tie' | 'n/a';
  /** signed weighted advantage, positive favours A */
  score: number;
  reasons: string[];
  caveats: string[];
  detail: string;
  efficiency: VerdictEfficiency;
}

function notConsulted(config: EfficiencyConfig): VerdictEfficiency {
  return { winner: 'n/a', advantage: 0, minAdvantage: config.minAdvantage, metrics: [], excluded: [] };
}

/**
 * Weighted relative advantage over the efficiency metrics both sides reported. Estimated values are
 * excluded: a tie-breaker built on a guess would be a guess. A metric whose configured weight is 0 is
 * not consulted at all.
 */
export function efficiencyTieBreak(
  comparisons: readonly Comparison[],
  config: EfficiencyConfig = DEFAULT_EFFICIENCY_CONFIG,
): EfficiencyOutcome {
  const parts: {
    key: EfficiencyMetricKey;
    label: string;
    weight: number;
    advantage: number;
    a: number;
    b: number;
  }[] = [];
  const excluded: VerdictEfficiency['excluded'] = [];
  for (const key of EFFICIENCY_METRIC_KEYS) {
    const weight = config.weights[key];
    if (weight <= 0) {
      excluded.push({ key, reason: 'weight is 0 in evaluation.efficiency' });
      continue;
    }
    const comparison = comparisons.find((c) => c.key === key);
    const usable =
      comparison !== undefined &&
      comparison.better !== 'n/a' &&
      typeof comparison.a.value === 'number' &&
      typeof comparison.b.value === 'number' &&
      comparison.a.status !== 'estimated' &&
      comparison.b.status !== 'estimated';
    if (!usable) {
      const reason =
        comparison === undefined || comparison.better === 'n/a'
          ? 'not reported by both sides'
          : 'estimated, not observed';
      excluded.push({ key, reason });
      continue;
    }
    const a = comparison.a.value as number;
    const b = comparison.b.value as number;
    const scale = Math.max(Math.abs(a), Math.abs(b));
    // lower is better for every efficiency metric: positive favours A
    const advantage = scale === 0 ? 0 : (b - a) / scale;
    parts.push({ key, label: comparison.label.toLowerCase(), weight, advantage, a, b });
  }

  const caveats = excluded.length
    ? [
        `Efficiency metrics left out of the tie-breaker: ${excluded
          .map((entry) => `${METRIC_LABELS[entry.key].toLowerCase()} (${entry.reason})`)
          .join('; ')}.`,
      ]
    : [];
  const metrics = parts.map(({ key, a, b, weight, advantage }) => ({ key, a, b, weight, advantage }));
  if (parts.length === 0) {
    return {
      winner: 'n/a',
      score: 0,
      reasons: [],
      caveats,
      detail: 'no efficiency metric was reported by both sides',
      efficiency: { winner: 'n/a', advantage: 0, minAdvantage: config.minAdvantage, metrics, excluded },
    };
  }

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const score = parts.reduce((sum, part) => sum + part.weight * part.advantage, 0) / totalWeight;
  const perMetric = parts
    .map((part) => {
      const percent = Math.round(relativeDifference(part.a, part.b) * 100);
      const who = part.advantage === 0 ? 'equal' : `${label(part.advantage > 0 ? 'a' : 'b')} by ${percent}%`;
      return `${part.label} ${who} (${formatMetric(part.key, part.a)} vs ${formatMetric(part.key, part.b)}, weight ${part.weight})`;
    })
    .join('; ');
  const magnitude = Math.round(Math.abs(score) * 100);
  const weightsText = parts
    .map((part) => `${part.label} ${percentText(part.weight / totalWeight)}`)
    .join(', ');

  if (Math.abs(score) < config.minAdvantage) {
    return {
      winner: 'tie',
      score,
      reasons: [],
      caveats: [
        ...caveats,
        `Efficiency did not separate the sides: weighted advantage ${magnitude}% is under the ${percentText(config.minAdvantage)} minimum (${perMetric}).`,
      ],
      detail: `weighted advantage ${magnitude}%, under the ${percentText(config.minAdvantage)} minimum`,
      efficiency: { winner: 'tie', advantage: score, minAdvantage: config.minAdvantage, metrics, excluded },
    };
  }
  const winner: Side = score > 0 ? 'a' : 'b';
  return {
    winner,
    score,
    reasons: [
      `Both sides passed every correctness check that ran. Side ${label(winner)} wins the efficiency tie-breaker ` +
        `with a weighted advantage of ${magnitude}%: ${perMetric}.`,
    ],
    caveats,
    detail: `side ${label(winner)} by ${magnitude}% weighted (${weightsText})`,
    efficiency: { winner, advantage: score, minAdvantage: config.minAdvantage, metrics, excluded },
  };
}

function decideDeterministic(
  report: EvaluationReport,
  sides: Record<Side, VerdictSideInput>,
  config: EfficiencyConfig,
): DeterministicOutcome {
  const results = report.results;
  const breakdown: VerdictBreakdownRow[] = [];
  const efficiency = notConsulted(config);
  const row = (
    factor: VerdictBreakdownRow['factor'],
    result: VerdictBreakdownRow['result'],
    detail: string,
  ) => breakdown.push({ factor, result, detail });

  // 1. Completion.
  const completed: Record<Side, boolean> = {
    a: sides.a.status === 'completed',
    b: sides.b.status === 'completed',
  };
  if (completed.a !== completed.b) {
    const winner: Side = completed.a ? 'a' : 'b';
    const loser = other(winner);
    row('completion', winner, `side ${label(loser)} ended as ${sides[loser].status}`);
    return {
      winner,
      method: 'deterministic',
      decisiveFactors: ['completion'],
      reasons: [
        `Side ${label(winner)} completed its run while side ${label(loser)} ended as ${sides[loser].status}.`,
      ],
      caveats: [],
      breakdown,
      efficiency,
    };
  }
  if (!completed.a && !completed.b) {
    row('completion', 'n/a', `side A ${sides.a.status}, side B ${sides.b.status}`);
    return {
      winner: 'inconclusive',
      method: 'insufficient',
      decisiveFactors: [],
      reasons: [`Neither run completed (side A: ${sides.a.status}, side B: ${sides.b.status}).`],
      caveats: ['Neither side finished, so there is nothing to compare.'],
      breakdown,
      efficiency,
    };
  }
  row('completion', 'tie', 'both sides completed');

  // 2. Repository tests, then regressions.
  const aTests = testsViewFor(results, 'a');
  const bTests = testsViewFor(results, 'b');
  const bothTests = testsRan(aTests) && testsRan(bTests);
  const testEvidenceCaveats: string[] = [];
  if (bothTests && aTests && bTests) {
    const bothCounts = testCountsKnown(aTests) && testCountsKnown(bTests);
    for (const side of ['a', 'b'] as const) {
      const mine = side === 'a' ? aTests : bTests;
      const theirs = side === 'a' ? bTests : aTests;
      // Counts decide only when BOTH sides produced counts: "no counts" is missing evidence, never a
      // failure. Otherwise the evaluator status (the exit code for the `exit-code` parser) is still
      // deterministic evidence — but only when both sides actually reported an exit code, because a
      // spawn error or a killed test command reports none.
      const byCounts = bothCounts && testsAllPassed(mine) && testsHaveFailures(theirs);
      const byStatus =
        mine.status === 'passed' &&
        theirs.status === 'failed' &&
        mine.exitCode !== null &&
        theirs.exitCode !== null;
      if (byCounts || byStatus) {
        const reason = byCounts
          ? `Side ${label(side)} passed the repository tests (${mine.passed}/${mine.total ?? mine.passed} passing) ` +
            `while side ${label(other(side))} had ${theirs.failed ?? 'failing'} failing test(s).`
          : `Side ${label(side)}'s test command succeeded (exit ${mine.exitCode ?? 'unknown'}) while side ` +
            `${label(other(side))}'s did not (exit ${theirs.exitCode ?? 'unknown'}).`;
        row(
          'tests',
          side,
          byCounts
            ? `side ${label(other(side))} had failing tests`
            : `side ${label(other(side))}'s test command failed`,
        );
        return {
          winner: side,
          method: 'deterministic',
          decisiveFactors: ['tests'],
          reasons: [reason],
          caveats: [],
          breakdown,
          efficiency,
        };
      }
    }
    // Nothing above decided. Name the side whose tests produced no usable evidence, so a fall-through
    // to a tie is never read as "both suites agreed".
    for (const view of [aTests, bTests]) {
      const counterpart = view.side === 'a' ? bTests : aTests;
      if (testCountsKnown(view)) continue;
      if (!testCountsKnown(counterpart) && view.exitCode !== null) continue;
      const exitText = view.exitCode === null ? 'and no exit code' : `exit ${view.exitCode}`;
      testEvidenceCaveats.push(
        `Side ${label(view.side)}'s repository tests reported no pass/fail counts (${exitText}), so they ` +
          'are not evidence of failure; the repository tests did not decide this battle.',
      );
    }
    row(
      'tests',
      testEvidenceCaveats.length ? 'n/a' : 'tie',
      testEvidenceCaveats.length ? 'one side produced no usable test evidence' : 'both suites passed',
    );

    const aReg = aTests.regressions;
    const bReg = bTests.regressions;
    if (aReg !== null && bReg !== null && aReg !== bReg) {
      if (aReg > 0 && bReg === 0) {
        row('regressions', 'b', `side A introduced ${aReg} regression(s)`);
        return {
          winner: 'b',
          method: 'deterministic',
          decisiveFactors: ['regressions'],
          reasons: [`Side A introduced ${aReg} regression(s); side B introduced none.`],
          caveats: [...testEvidenceCaveats],
          breakdown,
          efficiency,
        };
      }
      if (bReg > 0 && aReg === 0) {
        row('regressions', 'a', `side B introduced ${bReg} regression(s)`);
        return {
          winner: 'a',
          method: 'deterministic',
          decisiveFactors: ['regressions'],
          reasons: [`Side B introduced ${bReg} regression(s); side A introduced none.`],
          caveats: [...testEvidenceCaveats],
          breakdown,
          efficiency,
        };
      }
    }
    row(
      'regressions',
      aReg === null || bReg === null ? 'n/a' : 'tie',
      aReg === null || bReg === null
        ? 'regression counts not available for both sides'
        : `${aReg} vs ${bReg}`,
    );
  } else {
    row('tests', 'n/a', 'repository tests did not run for both sides');
    row('regressions', 'n/a', 'repository tests did not run for both sides');
  }

  // 3. Assertions.
  const aAssert = assertionsViewFor(results, 'a');
  const bAssert = assertionsViewFor(results, 'b');
  const bothAssert = aAssert !== null && bAssert !== null && aAssert.total > 0;
  if (bothAssert && aAssert && bAssert && aAssert.passed !== bAssert.passed) {
    const winner: Side = aAssert.passed > bAssert.passed ? 'a' : 'b';
    const winnerView = winner === 'a' ? aAssert : bAssert;
    const loserView = winner === 'a' ? bAssert : aAssert;
    row(
      'assertions',
      winner,
      `${winnerView.passed}/${winnerView.total} vs ${loserView.passed}/${loserView.total}`,
    );
    return {
      winner,
      method: 'deterministic',
      decisiveFactors: ['assertions'],
      reasons: [
        `Side ${label(winner)} satisfied ${winnerView.passed}/${winnerView.total} task assertions, ` +
          `side ${label(other(winner))} satisfied ${loserView.passed}/${loserView.total}.`,
      ],
      caveats: [...testEvidenceCaveats],
      breakdown,
      efficiency,
    };
  }
  row(
    'assertions',
    bothAssert ? 'tie' : 'n/a',
    bothAssert && aAssert
      ? `${aAssert.passed}/${aAssert.total} on both sides`
      : 'no task assertions ran for both sides',
  );

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
      row('build', winner, `side ${label(other(winner))} failed ${failed}`);
      return {
        winner,
        method: 'deterministic',
        decisiveFactors: ['build'],
        reasons: [
          `Side ${label(winner)} passed every build check; side ${label(other(winner))} failed ${failed}.`,
        ],
        caveats: [...testEvidenceCaveats],
        breakdown,
        efficiency,
      };
    }
  }
  row(
    'build',
    bothBuild ? 'tie' : 'n/a',
    bothBuild ? 'same result on both sides' : 'no build checks ran for both sides',
  );

  // 5. Nothing about correctness separated the sides.
  if (!bothTests && !bothAssert && !bothBuild) {
    row('efficiency', 'n/a', 'not consulted: no correctness evidence to gate it');
    return {
      winner: 'inconclusive',
      method: 'insufficient',
      decisiveFactors: [],
      reasons: ['No deterministic evaluator produced a result for both sides.'],
      caveats: [
        'Add evaluation.tests (a test command) or evaluation.assertions to this battle to get a deterministic winner.',
      ],
      breakdown,
      efficiency,
    };
  }

  // 6. Efficiency breaks a clean tie, never a dirty one: a side whose test evidence is missing has not
  // proven it is equally correct, so efficiency stays a caveat for that battle.
  if (testEvidenceCaveats.length === 0) {
    const tieBreak = efficiencyTieBreak(report.comparisons, config);
    row('efficiency', tieBreak.winner, tieBreak.detail);
    if (tieBreak.winner === 'a' || tieBreak.winner === 'b') {
      return {
        winner: tieBreak.winner,
        method: 'deterministic',
        decisiveFactors: ['efficiency'],
        reasons: tieBreak.reasons,
        caveats: tieBreak.caveats,
        breakdown,
        efficiency: tieBreak.efficiency,
      };
    }
    return {
      winner: 'tie',
      method: 'deterministic',
      decisiveFactors: [],
      reasons: [
        'Every correctness check that ran came out equal for both sides, and efficiency did not separate them.',
      ],
      caveats: tieBreak.caveats,
      breakdown,
      efficiency: tieBreak.efficiency,
    };
  }
  row('efficiency', 'n/a', 'not consulted: one side produced no usable test evidence');
  return {
    winner: 'tie',
    method: 'deterministic',
    decisiveFactors: [],
    reasons: ['No deterministic check separated the sides on evidence both sides produced.'],
    caveats: [...testEvidenceCaveats],
    breakdown,
    efficiency,
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
 * Turns an evaluation report into a winner. Correctness gates decide first, in a fixed order; efficiency
 * breaks a tie only between sides that proved themselves equally correct; the optional judge is reported
 * but can never override any of it.
 */
export function decideVerdict(
  report: EvaluationReport,
  sides: Record<Side, VerdictSideInput>,
  options: DecideVerdictOptions = {},
): Verdict {
  const config = options.efficiency ?? DEFAULT_EFFICIENCY_CONFIG;
  const outcome = decideDeterministic(report, sides, config);
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
    breakdown: outcome.breakdown,
    efficiency: outcome.efficiency,
    judge,
  };
}
