import type { Evaluator } from '../types.js';
import { assertionsEvaluator, ASSERTIONS_ID } from './assertions.js';
import { buildChecksEvaluator, BUILD_CHECKS_ID } from './build-checks.js';
import { diffSignalsEvaluator, DIFF_SIGNALS_ID } from './diff-signals.js';
import { judgeEvaluator, JUDGE_ID } from './judge.js';
import { repoTestsEvaluator, REPO_TESTS_ID } from './repo-tests.js';

/** Run order matters: cheap deterministic signals first, the optional subjective judge last. */
export const builtinEvaluators: Evaluator[] = [
  repoTestsEvaluator,
  buildChecksEvaluator,
  assertionsEvaluator,
  diffSignalsEvaluator,
  judgeEvaluator,
];

/** Evaluators whose absence lowers verdict confidence. `diff-signals` is excluded: it never decides. */
export const DETERMINISTIC_EVALUATOR_IDS = [REPO_TESTS_ID, BUILD_CHECKS_ID, ASSERTIONS_ID] as const;

export const EVALUATOR_IDS = {
  repoTests: REPO_TESTS_ID,
  buildChecks: BUILD_CHECKS_ID,
  assertions: ASSERTIONS_ID,
  diffSignals: DIFF_SIGNALS_ID,
  judge: JUDGE_ID,
} as const;

export * from './assertions.js';
export * from './build-checks.js';
export * from './diff-signals.js';
export * from './judge.js';
export * from './repo-tests.js';
export {
  changedFilePaths,
  countedLines,
  diffLines,
  makeResult,
  resolveInWorkspace,
  runShellCommand,
  SIDES,
} from './shared.js';
export type { ShellOutcome } from './shared.js';
