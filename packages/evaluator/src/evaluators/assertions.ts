import fs from 'node:fs/promises';
import type { Assertion, EvaluatorResult, Side } from '@harness-arena/protocol';
import { matchesAnyGlob, normalizePath } from '../glob.js';
import type { Evaluator, EvaluationContext, SideContext } from '../types.js';
import { changedFilePaths, makeResult, resolveInWorkspace, runShellCommand, SIDES } from './shared.js';

export const ASSERTIONS_ID = 'assertions';

export interface AssertionCheck {
  index: number;
  type: Assertion['type'];
  label: string;
  passed: boolean;
  detail: string;
}

export interface AssertionsDetails {
  checks: AssertionCheck[];
  passed: number;
  failed: number;
  total: number;
}

export function describeAssertion(assertion: Assertion): string {
  if (assertion.label) return assertion.label;
  switch (assertion.type) {
    case 'file-exists':
      return `${assertion.path} exists`;
    case 'file-missing':
      return `${assertion.path} does not exist`;
    case 'file-contains':
      return `${assertion.path} matches /${assertion.pattern}/`;
    case 'file-not-contains':
      return `${assertion.path} does not match /${assertion.pattern}/`;
    case 'command':
      return `${assertion.command} exits ${assertion.expectExitCode}`;
    case 'diff-touches':
      return `diff touches ${assertion.paths.join(', ')}`;
    case 'diff-not-touches':
      return `diff does not touch ${assertion.paths.join(', ')}`;
    case 'max-files-changed':
      return `at most ${assertion.max} files changed`;
  }
}

async function readIfPresent(absolute: string): Promise<string | null> {
  try {
    return await fs.readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await fs.stat(absolute);
    return true;
  } catch {
    return false;
  }
}

function compilePattern(pattern: string, flags: string | undefined): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** Evaluates one assertion. Never throws: a broken assertion definition fails with a reason. */
export async function checkAssertion(
  assertion: Assertion,
  ctx: EvaluationContext,
  sideCtx: SideContext,
): Promise<{ passed: boolean; detail: string }> {
  switch (assertion.type) {
    case 'file-exists':
    case 'file-missing':
    case 'file-contains':
    case 'file-not-contains': {
      const absolute = resolveInWorkspace(sideCtx.workspace, assertion.path);
      if (!absolute) return { passed: false, detail: `path escapes the workspace: ${assertion.path}` };
      if (assertion.type === 'file-exists') {
        const found = await exists(absolute);
        return { passed: found, detail: found ? 'file exists' : 'file not found' };
      }
      if (assertion.type === 'file-missing') {
        const found = await exists(absolute);
        return { passed: !found, detail: found ? 'file exists' : 'file not found' };
      }
      const regex = compilePattern(assertion.pattern, assertion.flags);
      if (!regex)
        return { passed: false, detail: `invalid pattern: /${assertion.pattern}/${assertion.flags ?? ''}` };
      const content = await readIfPresent(absolute);
      if (content === null) {
        return assertion.type === 'file-contains'
          ? { passed: false, detail: 'file not found' }
          : { passed: true, detail: 'file not found, so it cannot contain the pattern' };
      }
      const found = regex.test(content);
      if (assertion.type === 'file-contains') {
        return { passed: found, detail: found ? 'pattern found' : 'pattern not found' };
      }
      return { passed: !found, detail: found ? 'pattern found' : 'pattern not found' };
    }
    case 'command': {
      const outcome = await runShellCommand({
        command: assertion.command,
        cwd: sideCtx.workspace,
        timeoutMs: assertion.timeoutMs,
        runner: ctx.runner,
        signal: ctx.signal,
      });
      const passed = outcome.exitCode === assertion.expectExitCode;
      const seen = outcome.exitCode === null ? 'no exit code' : `exit ${outcome.exitCode}`;
      return { passed, detail: `${seen} (expected ${assertion.expectExitCode})` };
    }
    case 'diff-touches':
    case 'diff-not-touches': {
      const paths = changedFilePaths(sideCtx.artifacts).map(normalizePath);
      const matched = paths.filter((p) => matchesAnyGlob(p, assertion.paths));
      if (assertion.type === 'diff-touches') {
        return {
          passed: matched.length > 0,
          detail: matched.length ? `matched ${matched.join(', ')}` : 'no changed file matched',
        };
      }
      return {
        passed: matched.length === 0,
        detail: matched.length ? `matched ${matched.join(', ')}` : 'no changed file matched',
      };
    }
    case 'max-files-changed': {
      const count = changedFilePaths(sideCtx.artifacts).length;
      return { passed: count <= assertion.max, detail: `${count} file(s) changed (max ${assertion.max})` };
    }
  }
}

async function checkSide(ctx: EvaluationContext, side: Side): Promise<EvaluatorResult> {
  const sideCtx = ctx.sides[side];
  const startedAt = Date.now();
  const checks: AssertionCheck[] = [];

  for (const [index, assertion] of ctx.spec.evaluation.assertions.entries()) {
    const outcome = await checkAssertion(assertion, ctx, sideCtx);
    checks.push({
      index,
      type: assertion.type,
      label: describeAssertion(assertion),
      passed: outcome.passed,
      detail: outcome.detail,
    });
  }

  const passed = checks.filter((c) => c.passed).length;
  const details: AssertionsDetails = { checks, passed, failed: checks.length - passed, total: checks.length };

  return makeResult(
    {
      evaluatorId: ASSERTIONS_ID,
      kind: 'deterministic',
      side,
      status: passed === checks.length ? 'passed' : 'failed',
      score: checks.length ? passed / checks.length : null,
      summary: `${passed}/${checks.length} assertions passed`,
      details,
    },
    startedAt,
  );
}

/**
 * Task assertions: the task author's definition of done. Checked against the workspace on disk and
 * against the collected diff, for both sides, whatever their run status (a crashed run that still
 * produced the required file is worth recording).
 */
export const assertionsEvaluator: Evaluator = {
  id: ASSERTIONS_ID,
  kind: 'deterministic',
  applies: (ctx) => ctx.spec.evaluation.assertions.length > 0,
  async run(ctx) {
    const results: EvaluatorResult[] = [];
    for (const side of SIDES) results.push(await checkSide(ctx, side));
    return results;
  },
};
