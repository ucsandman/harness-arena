import { emptyMetrics } from '@harness-arena/protocol';
import type { SideContext, TestOutcome } from './types.js';

/**
 * Builds a `SideContext` with harmless defaults. Exported for tests and for the demo battle: every
 * field is overridable, nothing here reaches a real run.
 */
export function makeSideContext(overrides: Partial<SideContext> = {}): SideContext {
  return {
    workspace: process.cwd(),
    startCommit: null,
    status: 'completed',
    metrics: emptyMetrics(),
    artifacts: { changedFiles: [] },
    finalResponse: null,
    baseline: null,
    ...overrides,
  };
}

/** Builds a `TestOutcome` with all-null counts, for baselines and fixtures in tests. */
export function makeTestOutcome(overrides: Partial<TestOutcome> = {}): TestOutcome {
  return {
    exitCode: 0,
    passed: null,
    failed: null,
    skipped: null,
    total: null,
    durationMs: 0,
    parser: 'exit-code',
    output: '',
    failingTests: [],
    ...overrides,
  };
}
