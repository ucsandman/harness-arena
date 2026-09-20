import { RATING_CATEGORIES, experimentSummarySchema } from '@harness-arena/protocol';
import type {
  BattleRecord,
  ExperimentSummary,
  MetricKey,
  RateSummary,
  RatingCategory,
  Side,
} from '@harness-arena/protocol';
import { evidenceStrength, metricDelta, rate } from './stats.js';

/**
 * The experiment summary: control vs treatment over a set of battles, as one pure function.
 *
 * It lives beside the statistics helpers rather than in the database package because both sides need
 * exactly the same numbers: `arena experiment run` computes it offline from the records it just
 * produced, and the server recomputes it from the battles linked to the experiment. Two
 * implementations would eventually disagree, and the CLI must not carry a database driver.
 */

// ---- pure summary ------------------------------------------------------------------------------

/** The verdict stages that decide correctness; efficiency only breaks a tie between correct sides. */
export const CORRECTNESS_FACTORS = ['completion', 'tests', 'regressions', 'assertions', 'build'] as const;

const PAIRED_METRICS = ['tokens_total', 'cost_usd', 'duration_ms'] as const satisfies readonly MetricKey[];

export interface ExperimentBattleInput {
  record: BattleRecord;
  /** which side of that battle ran the treatment */
  treatmentSide: Side;
}

/**
 * A free-form spec category as a rating category. Deliberately a local copy of the normalisation in
 * ratings.ts: the two modules must not import each other, and this one has no rating state.
 */
function categoryOf(raw: string | null | undefined): RatingCategory {
  if (!raw) return 'overall';
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return RATING_CATEGORIES.find((category) => category === normalized) ?? 'overall';
}

function otherSide(side: Side): Side {
  return side === 'a' ? 'b' : 'a';
}

/**
 * Did this side pass every correctness gate that actually ran? A breakdown row naming the other side
 * means this side lost that gate; `tie` means both sides cleared it; `n/a` means the gate could not
 * run and proves nothing either way. A battle with no gate that ran is not counted at all.
 */
export function correctnessOf(record: BattleRecord, side: Side): { ran: boolean; passed: boolean } {
  const rows = (record.verdict?.breakdown ?? []).filter(
    (row) => (CORRECTNESS_FACTORS as readonly string[]).includes(row.factor) && row.result !== 'n/a',
  );
  if (rows.length === 0) return { ran: false, passed: false };
  return { ran: true, passed: !rows.some((row) => row.result === otherSide(side)) };
}

/** A metric both sides can be compared on: a real number the adapter observed, never an estimate. */
function pairedMetric(record: BattleRecord, side: Side, key: MetricKey): number | null {
  const metric = record.runs[side].metrics[key];
  if (!metric) return null;
  if (metric.status === 'unavailable' || metric.status === 'estimated') return null;
  return typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value : null;
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value * 100)) + '%';
}

function points(value: number | null): string {
  if (value === null) return 'n/a';
  return (value > 0 ? '+' : '') + String(Math.round(value));
}

function sample(n: number): string {
  return '(' + String(n) + ' comparable battle' + (n === 1 ? '' : 's') + ')';
}

function deltaPoints(control: RateSummary, treatment: RateSummary): number | null {
  if (control.rate === null || treatment.rate === null) return null;
  return (treatment.rate - control.rate) * 100;
}

/**
 * Everything the experiment page, the CLI and the MCP tool show, from the battle records alone.
 *
 * "comparable" means both sides completed their run in that battle, so their metrics describe the
 * same work; correctness is counted over the battles where at least one correctness gate ran.
 */
export function computeExperimentSummary(battles: readonly ExperimentBattleInput[]): ExperimentSummary {
  const decided = battles.filter((entry) => entry.record.verdict !== null);

  let controlWins = 0;
  let treatmentWins = 0;
  let ties = 0;
  let inconclusive = 0;
  let controlPassed = 0;
  let treatmentPassed = 0;
  let gated = 0;

  const comparableEntries: ExperimentBattleInput[] = [];
  const byCategory = new Map<
    RatingCategory,
    { battles: number; gated: number; control: number; treatment: number }
  >();

  for (const entry of decided) {
    const treatment = entry.treatmentSide;
    const control = otherSide(treatment);
    const winner = entry.record.verdict?.winner ?? 'inconclusive';
    if (winner === 'tie') ties += 1;
    else if (winner === 'inconclusive') inconclusive += 1;
    else if (winner === treatment) treatmentWins += 1;
    else controlWins += 1;

    const controlCorrect = correctnessOf(entry.record, control);
    const treatmentCorrect = correctnessOf(entry.record, treatment);
    const ran = controlCorrect.ran || treatmentCorrect.ran;
    if (ran) {
      gated += 1;
      if (controlCorrect.passed) controlPassed += 1;
      if (treatmentCorrect.passed) treatmentPassed += 1;
    }

    const category = categoryOf(entry.record.spec.category);
    const bucket = byCategory.get(category) ?? { battles: 0, gated: 0, control: 0, treatment: 0 };
    bucket.battles += 1;
    if (ran) {
      bucket.gated += 1;
      if (controlCorrect.passed) bucket.control += 1;
      if (treatmentCorrect.passed) bucket.treatment += 1;
    }
    byCategory.set(category, bucket);

    if (entry.record.runs.a.status === 'completed' && entry.record.runs.b.status === 'completed') {
      comparableEntries.push(entry);
    }
  }

  const metricPairs = (key: MetricKey): { control: number[]; treatment: number[] } => {
    const control: number[] = [];
    const treatment: number[] = [];
    for (const entry of comparableEntries) {
      const t = pairedMetric(entry.record, entry.treatmentSide, key);
      const c = pairedMetric(entry.record, otherSide(entry.treatmentSide), key);
      if (t === null || c === null) continue;
      control.push(c);
      treatment.push(t);
    }
    return { control, treatment };
  };

  const [tokensPairs, costPairs, durationPairs] = PAIRED_METRICS.map(metricPairs) as [
    { control: number[]; treatment: number[] },
    { control: number[]; treatment: number[] },
    { control: number[]; treatment: number[] },
  ];
  const tokens = metricDelta(tokensPairs.control, tokensPairs.treatment);
  const cost = metricDelta(costPairs.control, costPairs.treatment);
  const duration = metricDelta(durationPairs.control, durationPairs.treatment);

  const controlRate = rate(controlPassed, gated);
  const treatmentRate = rate(treatmentPassed, gated);
  const correctnessDelta = deltaPoints(controlRate, treatmentRate);
  const comparable = comparableEntries.length;

  const conclusions: string[] = [];
  if (decided.length === 0) {
    conclusions.push('No battle reached a verdict, so this experiment shows nothing yet.');
  } else {
    if (gated === 0) {
      conclusions.push(
        'No correctness gate (tests, assertions, build) ran in ' +
          String(decided.length) +
          ' battle(s), so correctness could not be compared.',
      );
    } else if (correctnessDelta === null || Math.round(correctnessDelta) === 0) {
      conclusions.push(
        'Treatment and control were equally correct at ' +
          percent(treatmentRate.rate) +
          ' over ' +
          String(gated) +
          ' battle(s) with a correctness gate.',
      );
    } else {
      conclusions.push(
        'Treatment ' +
          (correctnessDelta > 0 ? 'improved' : 'reduced') +
          ' correctness from ' +
          percent(controlRate.rate) +
          ' to ' +
          percent(treatmentRate.rate) +
          ' (' +
          points(correctnessDelta) +
          ' points over ' +
          String(gated) +
          ' battle(s) with a correctness gate).',
      );
    }

    const metricSentence = (label: string, delta: typeof tokens): string | null => {
      if (delta.n === 0 || delta.deltaPercent === null) return null;
      const changePercent = Math.round(delta.deltaPercent * 100);
      if (changePercent === 0) return null;
      const direction = changePercent > 0 ? 'more' : 'less';
      const improved = correctnessDelta !== null && correctnessDelta > 0;
      const qualifier =
        changePercent > 0
          ? improved
            ? ' while improving correctness'
            : ' without improving correctness'
          : '';
      return (
        'Treatment used ' +
        String(Math.abs(changePercent)) +
        '% ' +
        direction +
        ' ' +
        label +
        qualifier +
        ' ' +
        sample(delta.n) +
        '.'
      );
    };
    for (const sentence of [
      metricSentence('tokens', tokens),
      metricSentence('spend', cost),
      metricSentence('wall-clock time', duration),
    ]) {
      if (sentence) conclusions.push(sentence);
    }

    conclusions.push(
      'Wins: treatment ' +
        String(treatmentWins) +
        ', control ' +
        String(controlWins) +
        ', ties ' +
        String(ties) +
        ', inconclusive ' +
        String(inconclusive) +
        ' over ' +
        String(decided.length) +
        ' decided battle(s).',
    );
  }

  return experimentSummarySchema.parse({
    battles: decided.length,
    comparable,
    wins: { control: controlWins, treatment: treatmentWins, ties, inconclusive },
    correctness: { control: controlRate, treatment: treatmentRate, deltaPoints: correctnessDelta },
    tokens,
    cost,
    duration,
    byCategory: [...byCategory.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([category, bucket]) => {
        const control = rate(bucket.control, bucket.gated);
        const treatment = rate(bucket.treatment, bucket.gated);
        return {
          category,
          battles: bucket.battles,
          correctness: { control, treatment, deltaPoints: deltaPoints(control, treatment) },
        };
      }),
    evidence: evidenceStrength(comparable),
    conclusions,
  });
}
