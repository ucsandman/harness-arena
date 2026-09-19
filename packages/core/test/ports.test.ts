import { describe, expect, it } from 'vitest';
import type {
  EvaluationContext as EvaluatorContext,
  JudgeRunner as EvaluatorJudge,
} from '@harness-arena/evaluator';
import type { EvaluationContext, JudgeRunner } from '../src/ports.js';

/**
 * The engine hands its EvaluationContext to `@harness-arena/evaluator`. Core used to declare its own
 * `JudgeRunner` shape, which was structurally incompatible with the evaluator's, so a judge that
 * satisfied core's port could never be used by the code it was passed to. These assignments are the
 * regression test: they are checked by `tsc -p tsconfig.typecheck.json`, not at runtime.
 */

type AssignableToEvaluator = (ctx: EvaluationContext) => EvaluatorContext['sides'];

const judgeIsTheEvaluatorsJudge: EvaluatorJudge = {
  agentId: 'fake',
  model: null,
  ask: async () => 'the judge would answer here',
} satisfies JudgeRunner;

const sidesReachTheEvaluator: AssignableToEvaluator = (ctx) => ctx.sides;

describe('core ports match the evaluator they are handed to', () => {
  it('uses the evaluator JudgeRunner, not a look-alike', async () => {
    expect(judgeIsTheEvaluatorsJudge.agentId).toBe('fake');
    expect(await judgeIsTheEvaluatorsJudge.ask('x', { timeoutMs: 1 })).toContain('judge');
    expect(typeof sidesReachTheEvaluator).toBe('function');
  });
});
