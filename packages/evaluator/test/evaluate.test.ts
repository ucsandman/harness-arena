import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METRIC_KEYS, evaluationReportSchema, verdictSchema } from '@harness-arena/protocol';
import type { Evaluator } from '../src/index.js';
import { createFakeJudge, decideVerdict, evaluateBattle, makeTestOutcome } from '../src/index.js';
import { fakeRunner, makeCtx, makeSpec, shellLineOf } from './helpers.js';

let workspace: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-evaluate-'));
  await fs.writeFile(path.join(workspace, 'CHANGELOG.md'), '# Changelog\n\n- fixed math\n', 'utf8');
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const order: string[] = [];

function slowEvaluator(id: string, applies = true): Evaluator {
  return {
    id,
    kind: 'deterministic',
    applies: () => applies,
    async run() {
      order.push(`${id}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${id}:end`);
      return [
        {
          evaluatorId: id,
          kind: 'deterministic' as const,
          side: 'a' as const,
          status: 'passed' as const,
          score: null,
          summary: `${id} ok`,
          durationMs: 1,
        },
      ];
    },
  };
}

describe('evaluateBattle', () => {
  it('runs applicable evaluators one at a time and records their results', async () => {
    order.length = 0;
    const { ctx, events } = makeCtx({});
    const report = await evaluateBattle(ctx, [slowEvaluator('first'), slowEvaluator('second')]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(report.results.map((r) => r.evaluatorId)).toEqual(['first', 'second']);
    expect(evaluationReportSchema.parse(report).completedAt).toBe(report.completedAt);
    expect(events.map((e) => e.event.type)).toEqual([
      'evaluation.started',
      'evaluation.completed',
      'evaluation.started',
      'evaluation.completed',
    ]);
  });

  it('records evaluators that do not apply, with the reason', async () => {
    const { ctx } = makeCtx({});
    const report = await evaluateBattle(ctx);
    const byId = Object.fromEntries(report.unavailable.map((u) => [u.evaluatorId, u.reason]));
    expect(byId['repo-tests']).toContain('evaluation.tests');
    expect(byId['assertions']).toContain('evaluation.assertions');
    expect(byId['build-checks']).toContain('evaluation.build');
    expect(byId['judge']).toContain('disabled');
    expect(report.results.map((r) => r.evaluatorId)).toEqual(['diff-signals', 'diff-signals']);
  });

  it('turns a throwing evaluator into an error result instead of failing the battle', async () => {
    const broken: Evaluator = {
      id: 'broken',
      kind: 'deterministic',
      applies: () => true,
      run: async () => {
        throw new Error('boom');
      },
    };
    const { ctx, events } = makeCtx({});
    const report = await evaluateBattle(ctx, [broken, slowEvaluator('after')]);
    expect(report.results[0]).toMatchObject({ evaluatorId: 'broken', status: 'error', side: null });
    expect(report.results[0]?.summary).toContain('boom');
    expect(report.results[1]?.evaluatorId).toBe('after');
    expect(events.filter((e) => e.event.type === 'evaluation.completed')).toHaveLength(2);
  });

  it('records an evaluator whose applies() throws', async () => {
    const broken: Evaluator = {
      id: 'repo-tests',
      kind: 'deterministic',
      applies: () => {
        throw new Error('bad spec');
      },
      run: async () => [],
    };
    const { ctx } = makeCtx({});
    const report = await evaluateBattle(ctx, [broken]);
    expect(report.unavailable[0]).toMatchObject({ evaluatorId: 'repo-tests' });
    expect(report.unavailable[0]?.reason).toContain('bad spec');
  });

  it('treats a deterministic evaluator that could only skip as unavailable evidence', async () => {
    const spec = makeSpec({ evaluation: { tests: { command: 'npm test' } } });
    const { ctx } = makeCtx({ spec, a: { status: 'failed' }, b: { status: 'timed_out' } });
    const report = await evaluateBattle(ctx);
    expect(report.unavailable.map((u) => u.evaluatorId)).toContain('repo-tests');
    expect(
      report.results.filter((r) => r.evaluatorId === 'repo-tests').every((r) => r.status === 'skipped'),
    ).toBe(true);
  });

  it('compares every protocol metric and builds evidence', async () => {
    const { ctx } = makeCtx({});
    const report = await evaluateBattle(ctx, []);
    expect(report.comparisons).toHaveLength(METRIC_KEYS.length);
    expect(report.evidence).toEqual([]);
    expect(report.results).toEqual([]);
  });

  it('runs the real evaluators end to end and feeds a usable verdict', async () => {
    const spec = makeSpec({
      evaluation: {
        tests: { command: 'npm test', parser: 'auto', timeoutMs: 60_000 },
        build: ['npm run build'],
        assertions: [
          { type: 'file-exists', path: 'CHANGELOG.md', label: 'changelog written' },
          { type: 'max-files-changed', max: 5 },
        ],
        judge: { enabled: true },
      },
    });
    const judge = createFakeJudge('{"winner":"X","confidence":0.7,"rationale":"tidier"}');
    const runner = fakeRunner((call) => {
      const line = shellLineOf(call);
      if (line === 'npm run build') return { exitCode: 0 };
      return call.cwd.endsWith('side-b')
        ? { stdout: ['      Tests  1 failed | 3 passed (4)', ' FAIL  test/math.test.ts > adds'], exitCode: 1 }
        : { stdout: ['      Tests  4 passed (4)'], exitCode: 0 };
    });

    const { ctx, events } = makeCtx({
      spec,
      runner,
      judge,
      a: {
        workspace: path.join(workspace, 'side-a'),
        artifacts: {
          changedFiles: [{ path: 'src/math.ts', kind: 'modify', linesAdded: 2, linesRemoved: 1 }],
        },
        baseline: makeTestOutcome({
          passed: 3,
          failed: 1,
          total: 4,
          failingTests: ['test/math.test.ts > adds'],
        }),
      },
      b: {
        workspace: path.join(workspace, 'side-b'),
        artifacts: {
          changedFiles: [{ path: 'src/math.ts', kind: 'modify', linesAdded: 9, linesRemoved: 0 }],
        },
        baseline: makeTestOutcome({
          passed: 3,
          failed: 1,
          total: 4,
          failingTests: ['test/math.test.ts > adds'],
        }),
      },
    });

    const report = await evaluateBattle(ctx);
    expect(evaluationReportSchema.parse(report)).toBeTruthy();
    const ids = [...new Set(report.results.map((r) => r.evaluatorId))];
    expect(ids).toEqual(['repo-tests', 'build-checks', 'assertions', 'diff-signals', 'judge']);

    // The assertion about CHANGELOG.md fails for both sides: their workspaces do not exist on disk.
    const assertions = report.results.filter((r) => r.evaluatorId === 'assertions');
    expect(assertions.every((r) => r.status === 'failed')).toBe(true);

    const verdict = decideVerdict(report, {
      a: { status: ctx.sides.a.status, metrics: ctx.sides.a.metrics },
      b: { status: ctx.sides.b.status, metrics: ctx.sides.b.metrics },
    });
    expect(verdictSchema.parse(verdict)).toBeTruthy();
    expect(verdict).toMatchObject({ winner: 'a', decisiveFactors: ['tests'] });
    expect(verdict.judge).not.toBeNull();
    expect(events.some((e) => e.event.type === 'test.completed')).toBe(true);

    const prompt = judge.prompts[0] ?? '';
    expect(prompt).toContain('Candidate X');
    expect(/\bside [ab]\b/i.test(prompt)).toBe(false);
  });
});
