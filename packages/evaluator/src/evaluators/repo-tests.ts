import type { EvaluatorResult } from '@harness-arena/protocol';
import { runTests } from '../run-tests.js';
import type { Evaluator, TestOutcome } from '../types.js';
import { makeResult, SIDES } from './shared.js';

export const REPO_TESTS_ID = 'repo-tests';

export interface RepoTestsDetails {
  command: string;
  parser: string;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  total: number | null;
  durationMs: number;
  failingTests: string[];
  /** tests failing after the run that were not failing in the baseline; null without a baseline */
  regressions: number | null;
  regressionTests: string[];
  baseline: {
    passed: number | null;
    failed: number | null;
    total: number | null;
    failingTests: string[];
  } | null;
}

export interface RegressionOutcome {
  count: number | null;
  tests: string[];
  method: 'names' | 'counts' | 'no-baseline' | 'unknown';
}

/**
 * A regression is a test failing now that was not failing before the agent touched the repo. Names are
 * used when either side of the comparison reported any; otherwise the failed-count delta is the best
 * available answer, and the method is recorded so the report can say which one it used.
 */
export function computeRegressions(baseline: TestOutcome | null, post: TestOutcome): RegressionOutcome {
  if (!baseline) return { count: null, tests: [], method: 'no-baseline' };
  if (post.failingTests.length || baseline.failingTests.length) {
    const before = new Set(baseline.failingTests);
    const tests = post.failingTests.filter((name) => !before.has(name));
    return { count: tests.length, tests, method: 'names' };
  }
  if (typeof post.failed === 'number' && typeof baseline.failed === 'number') {
    return { count: Math.max(0, post.failed - baseline.failed), tests: [], method: 'counts' };
  }
  return { count: null, tests: [], method: 'unknown' };
}

function summarize(outcome: TestOutcome, regressions: RegressionOutcome): string {
  const parts: string[] = [];
  if (outcome.total !== null) parts.push(`${outcome.passed ?? 0}/${outcome.total} tests passed`);
  else parts.push(`exit code ${outcome.exitCode === null ? 'unknown' : outcome.exitCode}`);
  if (outcome.failed) parts.push(`${outcome.failed} failed`);
  if (regressions.count) parts.push(`${regressions.count} regression${regressions.count === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Runs the configured test command in each completed workspace. Counts come from the parser; the
 * status is the honest combination of "the command succeeded" and "no test failed", so an `exit-code`
 * parser (no counts at all) still produces a verdict-usable signal.
 */
export const repoTestsEvaluator: Evaluator = {
  id: REPO_TESTS_ID,
  kind: 'deterministic',
  applies: (ctx) => ctx.spec.evaluation.tests !== undefined,
  async run(ctx) {
    const tests = ctx.spec.evaluation.tests;
    if (!tests) return [];
    const results: EvaluatorResult[] = [];

    for (const side of SIDES) {
      const sideCtx = ctx.sides[side];
      if (sideCtx.status !== 'completed') {
        results.push(
          makeResult({
            evaluatorId: REPO_TESTS_ID,
            kind: 'deterministic',
            side,
            status: 'skipped',
            score: null,
            summary: `run ${sideCtx.status}; tests not run`,
            details: { runStatus: sideCtx.status },
            durationMs: 0,
          }),
        );
        continue;
      }

      const startedAt = Date.now();
      ctx.emit(side, {
        type: 'test.started',
        payload: { command: tests.command, phase: 'post' },
        confidence: 'observed',
      });

      const outcome = await runTests({
        command: tests.command,
        cwd: sideCtx.workspace,
        parser: tests.parser,
        timeoutMs: tests.timeoutMs,
        runner: ctx.runner,
        signal: ctx.signal,
      });

      ctx.emit(side, {
        type: 'test.completed',
        payload: {
          command: tests.command,
          phase: 'post',
          exitCode: outcome.exitCode,
          passed: outcome.passed,
          failed: outcome.failed,
          skipped: outcome.skipped,
          total: outcome.total,
          durationMs: outcome.durationMs,
          parser: outcome.parser,
        },
        confidence: 'observed',
      });

      const regressions = computeRegressions(sideCtx.baseline, outcome);
      const noFailures = outcome.failed === 0 || outcome.failed === null;
      const passedAll = outcome.exitCode === 0 && noFailures;
      const score =
        outcome.passed !== null && outcome.total !== null && outcome.total > 0
          ? Math.min(1, Math.max(0, outcome.passed / outcome.total))
          : null;

      const details: RepoTestsDetails = {
        command: tests.command,
        parser: outcome.parser,
        exitCode: outcome.exitCode,
        passed: outcome.passed,
        failed: outcome.failed,
        skipped: outcome.skipped,
        total: outcome.total,
        durationMs: outcome.durationMs,
        failingTests: outcome.failingTests,
        regressions: regressions.count,
        regressionTests: regressions.tests,
        baseline: sideCtx.baseline
          ? {
              passed: sideCtx.baseline.passed,
              failed: sideCtx.baseline.failed,
              total: sideCtx.baseline.total,
              failingTests: sideCtx.baseline.failingTests,
            }
          : null,
      };

      ctx.logger.debug('repo-tests finished', {
        side,
        exitCode: outcome.exitCode,
        passed: outcome.passed,
        failed: outcome.failed,
        regressions: regressions.count,
      });

      results.push(
        makeResult(
          {
            evaluatorId: REPO_TESTS_ID,
            kind: 'deterministic',
            side,
            status: passedAll ? 'passed' : 'failed',
            score,
            summary: summarize(outcome, regressions),
            details,
          },
          startedAt,
        ),
      );
    }

    return results;
  },
};
