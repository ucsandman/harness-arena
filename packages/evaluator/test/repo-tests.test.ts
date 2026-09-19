import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChecksEvaluator,
  computeRegressions,
  makeTestOutcome,
  repoTestsEvaluator,
} from '../src/index.js';
import { fakeRunner, makeCtx, makeSpec, shellLineOf } from './helpers.js';

const workspaceA = path.join(os.tmpdir(), 'arena-side-a');
const workspaceB = path.join(os.tmpdir(), 'arena-side-b');

const FAIL_OUTPUT = [
  '      Tests  2 failed | 2 passed (4)',
  ' FAIL  test/math.test.ts > adds',
  ' FAIL  test/math.test.ts > subtracts',
];
const PASS_OUTPUT = ['      Tests  4 passed (4)'];

function testsSpec(overrides: Record<string, unknown> = {}) {
  return makeSpec({
    evaluation: { tests: { command: 'npm test', parser: 'auto', timeoutMs: 120_000, ...overrides } },
  });
}

describe('computeRegressions', () => {
  it('has no answer without a baseline', () => {
    expect(computeRegressions(null, makeTestOutcome({ failed: 2 }))).toEqual({
      count: null,
      tests: [],
      method: 'no-baseline',
    });
  });

  it('counts tests failing now that were not failing before, by name', () => {
    const baseline = makeTestOutcome({ failed: 1, failingTests: ['X'] });
    const post = makeTestOutcome({ failed: 2, failingTests: ['X', 'Y'] });
    expect(computeRegressions(baseline, post)).toEqual({ count: 1, tests: ['Y'], method: 'names' });
  });

  it('reports zero when the same tests keep failing', () => {
    const baseline = makeTestOutcome({ failed: 1, failingTests: ['X'] });
    const post = makeTestOutcome({ failed: 1, failingTests: ['X'] });
    expect(computeRegressions(baseline, post)).toMatchObject({ count: 0, method: 'names' });
  });

  it('falls back to the failed-count delta when no names are available', () => {
    const baseline = makeTestOutcome({ failed: 1 });
    const post = makeTestOutcome({ failed: 3 });
    expect(computeRegressions(baseline, post)).toEqual({ count: 2, tests: [], method: 'counts' });
  });

  it('never reports a negative regression count', () => {
    expect(computeRegressions(makeTestOutcome({ failed: 3 }), makeTestOutcome({ failed: 0 }))).toMatchObject({
      count: 0,
    });
  });

  it('says unknown when neither names nor counts exist', () => {
    expect(computeRegressions(makeTestOutcome({}), makeTestOutcome({}))).toMatchObject({
      count: null,
      method: 'unknown',
    });
  });
});

describe('repoTestsEvaluator', () => {
  it('applies only when a test command is configured', () => {
    expect(repoTestsEvaluator.applies(makeCtx({}).ctx)).toBe(false);
    expect(repoTestsEvaluator.applies(makeCtx({ spec: testsSpec() }).ctx)).toBe(true);
  });

  it('runs the command per side, emits test events and computes regressions', async () => {
    const runner = fakeRunner((call) =>
      call.cwd === workspaceA
        ? { stdout: FAIL_OUTPUT, exitCode: 1, durationMs: 2000 }
        : { stdout: PASS_OUTPUT, exitCode: 0, durationMs: 1500 },
    );
    const { ctx, events } = makeCtx({
      spec: testsSpec(),
      runner,
      a: {
        workspace: workspaceA,
        baseline: makeTestOutcome({
          failed: 1,
          passed: 3,
          total: 4,
          failingTests: ['test/math.test.ts > adds'],
        }),
      },
      b: {
        workspace: workspaceB,
        baseline: makeTestOutcome({
          failed: 1,
          passed: 3,
          total: 4,
          failingTests: ['test/math.test.ts > adds'],
        }),
      },
    });

    const results = await repoTestsEvaluator.run(ctx);
    expect(results.map((r) => r.side)).toEqual(['a', 'b']);

    const a = results[0];
    expect(a?.status).toBe('failed');
    expect(a?.score).toBe(0.5);
    expect(a?.details).toMatchObject({
      command: 'npm test',
      parser: 'vitest',
      exitCode: 1,
      passed: 2,
      failed: 2,
      total: 4,
      regressions: 1,
      regressionTests: ['test/math.test.ts > subtracts'],
    });
    expect(a?.summary).toContain('1 regression');

    const b = results[1];
    expect(b?.status).toBe('passed');
    expect(b?.score).toBe(1);
    expect(b?.details).toMatchObject({ passed: 4, failed: 0, regressions: 0 });

    expect(runner.calls.map((c) => c.cwd)).toEqual([workspaceA, workspaceB]);
    expect(runner.calls.every((c) => c.timeoutMs === 120_000)).toBe(true);

    const types = events.map((e) => `${e.side}:${e.event.type}`);
    expect(types).toEqual(['a:test.started', 'a:test.completed', 'b:test.started', 'b:test.completed']);
    const completed = events[1]?.event;
    expect(completed?.type).toBe('test.completed');
    if (completed?.type === 'test.completed') {
      expect(completed.payload).toMatchObject({
        phase: 'post',
        passed: 2,
        failed: 2,
        total: 4,
        parser: 'vitest',
      });
    }
  });

  it('skips a side whose run did not complete, and does not spawn anything for it', async () => {
    const runner = fakeRunner({ stdout: PASS_OUTPUT, exitCode: 0 });
    const { ctx } = makeCtx({
      spec: testsSpec(),
      runner,
      a: { workspace: workspaceA },
      b: { workspace: workspaceB, status: 'timed_out' },
    });
    const results = await repoTestsEvaluator.run(ctx);
    expect(results[1]).toMatchObject({ side: 'b', status: 'skipped', score: null });
    expect(results[1]?.summary).toContain('timed_out');
    expect(runner.calls).toHaveLength(1);
  });

  it('reuses the engine-measured post-run outcome instead of running the suite again', async () => {
    const runner = fakeRunner({ stdout: PASS_OUTPUT, exitCode: 0 });
    const baseline = makeTestOutcome({
      failed: 1,
      passed: 3,
      total: 4,
      failingTests: ['test/math.test.ts > adds'],
    });
    const { ctx, events } = makeCtx({
      spec: testsSpec(),
      runner,
      a: {
        workspace: workspaceA,
        baseline,
        postTests: makeTestOutcome({
          exitCode: 0,
          passed: 4,
          failed: 0,
          total: 4,
          durationMs: 4321,
          parser: 'vitest',
        }),
      },
      b: {
        workspace: workspaceB,
        baseline,
        postTests: makeTestOutcome({
          exitCode: 1,
          passed: 2,
          failed: 2,
          total: 4,
          durationMs: 1234,
          parser: 'vitest',
          failingTests: ['test/math.test.ts > adds', 'test/math.test.ts > subtracts'],
        }),
      },
    });

    const results = await repoTestsEvaluator.run(ctx);

    // nothing spawned, and no duplicate test events: the engine already emitted them
    expect(runner.calls).toHaveLength(0);
    expect(events).toHaveLength(0);

    expect(results[0]).toMatchObject({ side: 'a', status: 'passed', score: 1 });
    expect(results[0]?.details).toMatchObject({ passed: 4, failed: 0, durationMs: 4321, regressions: 0 });
    expect(results[1]).toMatchObject({ side: 'b', status: 'failed', score: 0.5 });
    expect(results[1]?.details).toMatchObject({
      passed: 2,
      failed: 2,
      durationMs: 1234,
      regressions: 1,
      regressionTests: ['test/math.test.ts > subtracts'],
    });
  });

  it('runs the command itself when the engine measured no post-run outcome', async () => {
    const runner = fakeRunner({ stdout: PASS_OUTPUT, exitCode: 0 });
    const { ctx, events } = makeCtx({
      spec: testsSpec(),
      runner,
      a: { workspace: workspaceA, postTests: null },
      b: { workspace: workspaceB, postTests: null },
    });
    const results = await repoTestsEvaluator.run(ctx);
    expect(runner.calls).toHaveLength(2);
    expect(events.map((e) => e.event.type)).toEqual([
      'test.started',
      'test.completed',
      'test.started',
      'test.completed',
    ]);
    expect(results[0]).toMatchObject({ status: 'passed' });
  });

  it('passes on exit code 0 when the parser reports no counts', async () => {
    const runner = fakeRunner({ stdout: ['done'], exitCode: 0 });
    const { ctx } = makeCtx({
      spec: testsSpec({ parser: 'exit-code' }),
      runner,
      a: { workspace: workspaceA },
    });
    const results = await repoTestsEvaluator.run(ctx);
    expect(results[0]).toMatchObject({ status: 'passed', score: null });
    expect(results[0]?.details).toMatchObject({ passed: null, failed: null, parser: 'exit-code' });
  });
});

describe('buildChecksEvaluator', () => {
  it('does not apply without commands', () => {
    expect(buildChecksEvaluator.applies(makeCtx({}).ctx)).toBe(false);
  });

  it('runs every build, lint and typecheck command and fails when any exits non-zero', async () => {
    const spec = makeSpec({
      evaluation: { build: ['npm run build'], lint: ['npm run lint'], typecheck: ['npm run typecheck'] },
    });
    const runner = fakeRunner((call) => ({ exitCode: shellLineOf(call) === 'npm run lint' ? 1 : 0 }));
    const { ctx, events } = makeCtx({
      spec,
      runner,
      a: { workspace: workspaceA },
      b: { workspace: workspaceB },
    });

    expect(buildChecksEvaluator.applies(ctx)).toBe(true);
    const results = await buildChecksEvaluator.run(ctx);

    expect(results[0]).toMatchObject({ side: 'a', status: 'failed', score: 2 / 3 });
    expect(results[0]?.summary).toContain('failed: lint');
    expect(results[0]?.details).toMatchObject({ ok: 2, total: 3 });
    expect(runner.calls).toHaveLength(6);
    expect(runner.calls[0]?.cwd).toBe(workspaceA);
    expect(events.filter((e) => e.event.type === 'command.started')).toHaveLength(6);
  });

  it('passes when every command exits zero', async () => {
    const spec = makeSpec({ evaluation: { build: ['npm run build'] } });
    const { ctx } = makeCtx({ spec, runner: fakeRunner({ exitCode: 0 }), a: { workspace: workspaceA } });
    const results = await buildChecksEvaluator.run(ctx);
    expect(results[0]).toMatchObject({ status: 'passed', score: 1 });
  });

  it('skips a side that did not complete', async () => {
    const spec = makeSpec({ evaluation: { build: ['npm run build'] } });
    const runner = fakeRunner({ exitCode: 0 });
    const { ctx } = makeCtx({ spec, runner, a: { status: 'failed' }, b: {} });
    const results = await buildChecksEvaluator.run(ctx);
    expect(results[0]).toMatchObject({ side: 'a', status: 'skipped' });
    expect(runner.calls).toHaveLength(1);
  });
});
