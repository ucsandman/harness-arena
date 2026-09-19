import type { EvaluationReport, EvaluatorResult } from '@harness-arena/protocol';
import { buildEvidence, compareMetrics } from './compare.js';
import {
  builtinEvaluators,
  ASSERTIONS_ID,
  BUILD_CHECKS_ID,
  DETERMINISTIC_EVALUATOR_IDS,
  JUDGE_ID,
  REPO_TESTS_ID,
} from './evaluators/index.js';
import type { Evaluator, EvaluationContext } from './types.js';

function unavailableReason(evaluatorId: string, ctx: EvaluationContext): string {
  switch (evaluatorId) {
    case REPO_TESTS_ID:
      return 'no test command configured (evaluation.tests)';
    case BUILD_CHECKS_ID:
      return 'no build, lint or typecheck commands configured (evaluation.build/lint/typecheck)';
    case ASSERTIONS_ID:
      return 'no task assertions configured (evaluation.assertions)';
    case JUDGE_ID:
      return ctx.spec.evaluation.judge.enabled
        ? 'judge is enabled but no judge runner was provided'
        : 'judge is disabled (evaluation.judge.enabled)';
    default:
      return 'evaluator did not apply to this battle';
  }
}

/**
 * Runs the applicable evaluators sequentially (they all compete for the same CPU, so overlapping them
 * would distort the durations they measure), collects their results, and pairs the metrics. An
 * evaluator that throws becomes an `error` result: one broken plugin never loses the whole battle.
 */
export async function evaluateBattle(
  ctx: EvaluationContext,
  evaluators: readonly Evaluator[] = builtinEvaluators,
): Promise<EvaluationReport> {
  const results: EvaluatorResult[] = [];
  const notRun: Array<{ evaluatorId: string; reason: string }> = [];

  for (const evaluator of evaluators) {
    let applicable = false;
    try {
      applicable = evaluator.applies(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn('evaluator applies() threw', { evaluatorId: evaluator.id, message });
      notRun.push({ evaluatorId: evaluator.id, reason: `applies() failed: ${message}` });
      continue;
    }
    if (!applicable) {
      notRun.push({ evaluatorId: evaluator.id, reason: unavailableReason(evaluator.id, ctx) });
      continue;
    }

    ctx.emit(null, {
      type: 'evaluation.started',
      payload: { evaluatorId: evaluator.id, side: null },
      confidence: 'derived',
    });
    const startedAt = Date.now();
    let produced: EvaluatorResult[];
    try {
      produced = await evaluator.run(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error('evaluator failed', { evaluatorId: evaluator.id, message });
      produced = [
        {
          evaluatorId: evaluator.id,
          kind: evaluator.kind,
          side: null,
          status: 'error',
          score: null,
          summary: `evaluator failed: ${message}`,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      ];
    }
    results.push(...produced);
    for (const result of produced) {
      ctx.emit(result.side, {
        type: 'evaluation.completed',
        payload: {
          evaluatorId: result.evaluatorId,
          side: result.side,
          status: result.status,
          summary: result.summary,
        },
        confidence: 'derived',
      });
    }
  }

  // An evaluator that ran but could only skip or error is unavailable evidence too, and the verdict
  // confidence must feel that.
  const deterministicIds = DETERMINISTIC_EVALUATOR_IDS as readonly string[];
  for (const id of deterministicIds) {
    if (notRun.some((entry) => entry.evaluatorId === id)) continue;
    const mine = results.filter((r) => r.evaluatorId === id);
    if (!mine.length) continue;
    if (mine.every((r) => r.status === 'skipped' || r.status === 'error')) {
      const reason = mine[0]?.summary ?? 'produced no usable result';
      notRun.push({ evaluatorId: id, reason });
    }
  }

  const comparisons = compareMetrics(ctx.sides.a.metrics, ctx.sides.b.metrics);
  return {
    results,
    comparisons,
    evidence: buildEvidence(comparisons, results),
    unavailable: notRun,
    completedAt: new Date().toISOString(),
  };
}
