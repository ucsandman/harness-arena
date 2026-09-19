import type { EvaluatorResult } from '@harness-arena/protocol';
import type { Evaluator, EvaluationContext } from '../types.js';
import { makeResult, runShellCommand, SIDES } from './shared.js';

export const BUILD_CHECKS_ID = 'build-checks';

/** Per-command budget. Build/lint/typecheck lines are not agent runs; they get a flat 10 minutes. */
export const CHECK_TIMEOUT_MS = 600_000;

export type CheckKind = 'build' | 'lint' | 'typecheck';

export interface CheckResult {
  kind: CheckKind;
  command: string;
  exitCode: number | null;
  ok: boolean;
  durationMs: number;
  timedOut: boolean;
}

export interface BuildChecksDetails {
  checks: CheckResult[];
  ok: number;
  total: number;
}

function plannedChecks(ctx: EvaluationContext): Array<{ kind: CheckKind; command: string }> {
  const { build, lint, typecheck } = ctx.spec.evaluation;
  const planned: Array<{ kind: CheckKind; command: string }> = [];
  for (const command of build ?? []) planned.push({ kind: 'build', command });
  for (const command of lint ?? []) planned.push({ kind: 'lint', command });
  for (const command of typecheck ?? []) planned.push({ kind: 'typecheck', command });
  return planned;
}

/** Runs every configured build/lint/typecheck command in each completed workspace. */
export const buildChecksEvaluator: Evaluator = {
  id: BUILD_CHECKS_ID,
  kind: 'deterministic',
  applies: (ctx) => plannedChecks(ctx).length > 0,
  async run(ctx) {
    const planned = plannedChecks(ctx);
    const results: EvaluatorResult[] = [];

    for (const side of SIDES) {
      const sideCtx = ctx.sides[side];
      if (sideCtx.status !== 'completed') {
        results.push(
          makeResult({
            evaluatorId: BUILD_CHECKS_ID,
            kind: 'deterministic',
            side,
            status: 'skipped',
            score: null,
            summary: `run ${sideCtx.status}; build checks not run`,
            details: { runStatus: sideCtx.status },
            durationMs: 0,
          }),
        );
        continue;
      }

      const startedAt = Date.now();
      const checks: CheckResult[] = [];
      for (const [index, planEntry] of planned.entries()) {
        const commandId = `${side}-${planEntry.kind}-${index}`;
        ctx.emit(side, {
          type: 'command.started',
          payload: { commandId, command: planEntry.command, cwd: sideCtx.workspace },
          confidence: 'observed',
        });
        const outcome = await runShellCommand({
          command: planEntry.command,
          cwd: sideCtx.workspace,
          timeoutMs: CHECK_TIMEOUT_MS,
          runner: ctx.runner,
          signal: ctx.signal,
        });
        ctx.emit(side, {
          type: 'command.completed',
          payload: { commandId, exitCode: outcome.exitCode, durationMs: outcome.durationMs },
          confidence: 'observed',
        });
        checks.push({
          kind: planEntry.kind,
          command: planEntry.command,
          exitCode: outcome.exitCode,
          ok: outcome.exitCode === 0,
          durationMs: outcome.durationMs,
          timedOut: outcome.timedOut,
        });
      }

      const ok = checks.filter((c) => c.ok).length;
      const details: BuildChecksDetails = { checks, ok, total: checks.length };
      const failedKinds = checks.filter((c) => !c.ok).map((c) => c.kind);

      results.push(
        makeResult(
          {
            evaluatorId: BUILD_CHECKS_ID,
            kind: 'deterministic',
            side,
            status: ok === checks.length ? 'passed' : 'failed',
            score: checks.length ? ok / checks.length : null,
            summary:
              ok === checks.length
                ? `${ok}/${checks.length} checks passed`
                : `${ok}/${checks.length} checks passed; failed: ${[...new Set(failedKinds)].join(', ')}`,
            details,
          },
          startedAt,
        ),
      );
    }

    return results;
  },
};
