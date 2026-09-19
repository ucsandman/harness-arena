/**
 * @harness-arena/evaluator — deterministic evaluation plugins and the verdict engine.
 *
 * Nothing here spawns an agent CLI or spends model credits. Test commands and build checks run through
 * an injected `ProcessRunner`; the optional LLM judge runs through a `JudgeRunner` supplied by the
 * caller (core/cli), which uses the user's own authenticated CLI.
 */

export type {
  EvaluationContext,
  Evaluator,
  JudgeRunner,
  Logger,
  ParsedTestOutput,
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
  SideContext,
  TestOutcome,
  TestParser,
} from './types.js';
export { silentLogger, TEST_PARSERS } from './types.js';

export { parseTestOutput } from './test-parsers.js';
export {
  createOutputCollector,
  runTests,
  shellInvocation,
  OUTPUT_CAP_BYTES,
  PROCESS_OUTPUT_CAP_BYTES,
} from './run-tests.js';
export type { OutputCollector, RunTestsOptions } from './run-tests.js';

export { matchesAnyGlob, matchesGlob, normalizePath } from './glob.js';

export {
  buildEvidence,
  compareMetrics,
  relativeDifference,
  DECISIVE_METRIC_KEYS,
  NOTABLE_METRIC_KEYS,
  NOTABLE_RELATIVE_THRESHOLD,
} from './compare.js';

export {
  assertionsViewFor,
  buildChecksViewFor,
  judgeOpinionOf,
  testsViewFor,
  testsViews,
} from './details.js';
export type { AssertionsView, BuildChecksView, TestsView } from './details.js';

export { evaluateBattle } from './evaluate.js';
export {
  decideVerdict,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  FACTOR_CONFIDENCE,
  UNAVAILABLE_PENALTY,
} from './verdict.js';
export type { VerdictSideInput } from './verdict.js';

export { makeSideContext, makeTestOutcome } from './testing.js';

export * from './evaluators/index.js';
