import type { EvaluatorResult, JudgeOpinion, Side } from '@harness-arena/protocol';
import { judgeOpinionSchema } from '@harness-arena/protocol';
import { ASSERTIONS_ID, BUILD_CHECKS_ID, JUDGE_ID, REPO_TESTS_ID } from './evaluators/index.js';

/**
 * `EvaluatorResult.details` is `unknown` in the protocol on purpose (plugins own their shape), so the
 * comparison and verdict code reads it through these narrow, defensive views.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export interface TestsView {
  side: Side;
  status: EvaluatorResult['status'];
  passed: number | null;
  failed: number | null;
  total: number | null;
  regressions: number | null;
  failingTests: string[];
  exitCode: number | null;
}

export function testsViews(results: readonly EvaluatorResult[]): TestsView[] {
  const views: TestsView[] = [];
  for (const result of results) {
    if (result.evaluatorId !== REPO_TESTS_ID || result.side === null) continue;
    const details = asRecord(result.details) ?? {};
    views.push({
      side: result.side,
      status: result.status,
      passed: numOrNull(details.passed),
      failed: numOrNull(details.failed),
      total: numOrNull(details.total),
      regressions: numOrNull(details.regressions),
      failingTests: stringArray(details.failingTests),
      exitCode: numOrNull(details.exitCode),
    });
  }
  return views;
}

export function testsViewFor(results: readonly EvaluatorResult[], side: Side): TestsView | null {
  return testsViews(results).find((v) => v.side === side) ?? null;
}

export interface AssertionsView {
  side: Side;
  status: EvaluatorResult['status'];
  passed: number;
  failed: number;
  total: number;
  checks: Array<{ index: number; label: string; passed: boolean; detail: string }>;
}

export function assertionsViewFor(results: readonly EvaluatorResult[], side: Side): AssertionsView | null {
  const result = results.find((r) => r.evaluatorId === ASSERTIONS_ID && r.side === side);
  if (!result) return null;
  const details = asRecord(result.details) ?? {};
  const rawChecks = Array.isArray(details.checks) ? details.checks : [];
  const checks = rawChecks.flatMap((entry, i) => {
    const record = asRecord(entry);
    if (!record) return [];
    return [
      {
        index: numOrNull(record.index) ?? i,
        label: typeof record.label === 'string' ? record.label : `assertion ${i + 1}`,
        passed: record.passed === true,
        detail: typeof record.detail === 'string' ? record.detail : '',
      },
    ];
  });
  return {
    side,
    status: result.status,
    passed: numOrNull(details.passed) ?? checks.filter((c) => c.passed).length,
    failed: numOrNull(details.failed) ?? checks.filter((c) => !c.passed).length,
    total: numOrNull(details.total) ?? checks.length,
    checks,
  };
}

export interface BuildChecksView {
  side: Side;
  status: EvaluatorResult['status'];
  ok: number;
  total: number;
  failedKinds: string[];
}

export function buildChecksViewFor(results: readonly EvaluatorResult[], side: Side): BuildChecksView | null {
  const result = results.find((r) => r.evaluatorId === BUILD_CHECKS_ID && r.side === side);
  if (!result) return null;
  const details = asRecord(result.details) ?? {};
  const rawChecks = Array.isArray(details.checks) ? details.checks : [];
  const failedKinds: string[] = [];
  for (const entry of rawChecks) {
    const record = asRecord(entry);
    if (!record || record.ok === true) continue;
    if (typeof record.kind === 'string') failedKinds.push(record.kind);
  }
  return {
    side,
    status: result.status,
    ok: numOrNull(details.ok) ?? 0,
    total: numOrNull(details.total) ?? rawChecks.length,
    failedKinds: [...new Set(failedKinds)],
  };
}

export function judgeOpinionOf(results: readonly EvaluatorResult[]): JudgeOpinion | null {
  const result = results.find((r) => r.evaluatorId === JUDGE_ID && r.status === 'passed');
  if (!result) return null;
  const parsed = judgeOpinionSchema.safeParse(result.details);
  return parsed.success ? parsed.data : null;
}
