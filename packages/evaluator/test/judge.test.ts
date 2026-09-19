import { describe, expect, it } from 'vitest';
import { judgeOpinionSchema } from '@harness-arena/protocol';
import type { JudgeRunner } from '../src/index.js';
import {
  buildJudgePrompt,
  createFakeJudge,
  identityTokens,
  judgeEvaluator,
  parseJudgeResponse,
  pickLabels,
  JUDGE_DIFF_CAP_BYTES,
  JUDGE_TIMEOUT_MS,
} from '../src/index.js';
import { makeCtx, makeSpec } from './helpers.js';

const namedSpec = makeSpec({
  competitors: {
    a: {
      label: 'Alpha Harness',
      agent: { id: 'claude-code', model: 'opus-5' },
      harness: { source: 'https://github.com/acme/super-harness' },
    },
    b: {
      label: 'Beta Harness',
      agent: { id: 'codex', model: 'gpt-6' },
      harness: { source: 'https://github.com/othercorp/lean-kit' },
    },
  },
  evaluation: { judge: { enabled: true } },
});

function namedCtx(judge?: JudgeRunner) {
  return makeCtx({
    spec: namedSpec,
    ...(judge ? { judge } : {}),
    a: {
      artifacts: {
        diff: 'diff --git a/x.ts b/x.ts\n+// written by super-harness with claude-code\n',
        changedFiles: [],
      },
      finalResponse: 'Done. Alpha Harness followed its CLAUDE.md rules.',
    },
    b: {
      artifacts: { diff: 'diff --git a/y.ts b/y.ts\n+// lean-kit style\n', changedFiles: [] },
      finalResponse: 'Finished with codex defaults.',
    },
  });
}

describe('pickLabels', () => {
  it('randomizes which side is Candidate X', () => {
    expect(pickLabels(() => 0.1)).toEqual({ X: 'a', Y: 'b' });
    expect(pickLabels(() => 0.9)).toEqual({ X: 'b', Y: 'a' });
  });
});

describe('buildJudgePrompt', () => {
  it('is blind: no harness, agent, model name or side letter survives', () => {
    const { ctx } = namedCtx();
    const prompt = buildJudgePrompt(ctx, { X: 'a', Y: 'b' });

    expect(prompt).toContain('Candidate X');
    expect(prompt).toContain('Candidate Y');
    expect(prompt).toContain('[redacted]');
    for (const secret of [
      'super-harness',
      'lean-kit',
      'Alpha',
      'Beta',
      'claude-code',
      'codex',
      'opus-5',
      'gpt-6',
    ]) {
      expect(prompt.toLowerCase(), `leaked ${secret}`).not.toContain(secret.toLowerCase());
    }
    expect(/\bside [ab]\b/i.test(prompt)).toBe(false);
    expect(/\bcandidate [ab]\b/i.test(prompt)).toBe(false);
    expect(/\bharness\b/i.test(prompt)).toBe(false);
  });

  it('orders the candidates by the label mapping, not by side', () => {
    const { ctx } = makeCtx({
      spec: makeSpec({ evaluation: { judge: { enabled: true } } }),
      a: { artifacts: { diff: 'AAA-DIFF', changedFiles: [] }, finalResponse: 'A says' },
      b: { artifacts: { diff: 'BBB-DIFF', changedFiles: [] }, finalResponse: 'B says' },
    });
    const swapped = buildJudgePrompt(ctx, { X: 'b', Y: 'a' });
    expect(swapped.indexOf('BBB-DIFF')).toBeLessThan(swapped.indexOf('AAA-DIFF'));
    const straight = buildJudgePrompt(ctx, { X: 'a', Y: 'b' });
    expect(straight.indexOf('AAA-DIFF')).toBeLessThan(straight.indexOf('BBB-DIFF'));
  });

  it('caps each diff and includes the task and the rubric', () => {
    const big = `diff --git a/big.ts b/big.ts\n${'+x'.repeat(80_000)}\n`;
    const { ctx } = makeCtx({
      spec: makeSpec({ evaluation: { judge: { enabled: true, rubric: 'Only correctness matters.' } } }),
      a: { artifacts: { diff: big, changedFiles: [] } },
      b: { artifacts: { diff: 'small', changedFiles: [] } },
    });
    const prompt = buildJudgePrompt(ctx, { X: 'a', Y: 'b' });
    expect(prompt).toContain(`[truncated at ${JUDGE_DIFF_CAP_BYTES} bytes]`);
    expect(prompt).toContain('Only correctness matters.');
    expect(prompt).toContain('Fix the failing test in src/math.ts');
    expect(Buffer.byteLength(prompt)).toBeLessThan(JUDGE_DIFF_CAP_BYTES * 2 + 40_000);
  });

  it('only scrubs identity tokens that are specific enough to matter', () => {
    const tokens = identityTokens(namedCtx().ctx);
    expect(tokens).toContain('super-harness');
    expect(tokens).toContain('claude-code');
    expect(tokens).not.toContain('vanilla');
  });
});

describe('parseJudgeResponse', () => {
  const labels = { X: 'b', Y: 'a' } as const;

  it('maps the blind label back to a side', () => {
    expect(parseJudgeResponse('{"winner":"X","confidence":0.8,"rationale":"tighter"}', labels)).toEqual({
      winner: 'b',
      confidence: 0.8,
      rationale: 'tighter',
    });
    expect(parseJudgeResponse('{"winner":"Y","confidence":0.4,"rationale":"ok"}', labels)).toMatchObject({
      winner: 'a',
    });
    expect(parseJudgeResponse('{"winner":"tie","confidence":0.2,"rationale":"same"}', labels)).toMatchObject({
      winner: 'tie',
    });
  });

  it('tolerates code fences, surrounding prose, lowercase labels and string confidence', () => {
    const fenced = '```json\n{"winner":"x","confidence":"0.9","rationale":"clean"}\n```';
    expect(parseJudgeResponse(fenced, labels)).toMatchObject({ winner: 'b', confidence: 0.9 });
    const chatty = 'Here is my verdict:\n{"winner":"Y","confidence":0.5,"rationale":"fine"}\nThanks!';
    expect(parseJudgeResponse(chatty, labels)).toMatchObject({ winner: 'a' });
  });

  it('clamps confidence and defaults it when missing', () => {
    expect(parseJudgeResponse('{"winner":"X","confidence":7,"rationale":"r"}', labels)).toMatchObject({
      confidence: 1,
    });
    expect(parseJudgeResponse('{"winner":"X","rationale":"r"}', labels)).toMatchObject({ confidence: 0.5 });
  });

  it('refuses to guess a winner from an unusable reply', () => {
    expect(parseJudgeResponse('I prefer the first one.', labels)).toEqual({
      error: 'judge reply contained no JSON object',
    });
    expect(parseJudgeResponse('{"winner":"Z","confidence":0.5,"rationale":"r"}', labels)).toMatchObject({
      error: expect.stringContaining('required shape'),
    });
  });
});

describe('judgeEvaluator', () => {
  it('applies only when enabled and a judge runner exists', () => {
    expect(judgeEvaluator.applies(makeCtx({}).ctx)).toBe(false);
    expect(judgeEvaluator.applies(namedCtx().ctx)).toBe(false);
    expect(judgeEvaluator.applies(namedCtx(createFakeJudge('{}')).ctx)).toBe(true);
  });

  it('records a labeled, blind, subjective opinion', async () => {
    const judge = createFakeJudge('{"winner":"tie","confidence":0.55,"rationale":"both fine"}', {
      agentId: 'claude-code-judge',
      model: 'opus-5',
    });
    const { ctx } = namedCtx(judge);
    const results = await judgeEvaluator.run(ctx);
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result).toMatchObject({
      evaluatorId: 'judge',
      kind: 'subjective',
      side: null,
      status: 'passed',
      score: null,
    });
    const opinion = judgeOpinionSchema.parse(result?.details);
    expect(opinion).toMatchObject({
      winner: 'tie',
      confidence: 0.55,
      blind: true,
      subjective: true,
      judgeAgent: 'claude-code-judge',
      judgeModel: 'opus-5',
    });
    expect(judge.prompts).toHaveLength(1);
    expect(judge.prompts[0]).toContain('Candidate X');
  });

  it('asks with a bounded timeout', async () => {
    const seen: number[] = [];
    const judge: JudgeRunner = {
      agentId: 'fake',
      model: null,
      async ask(_prompt, opts) {
        seen.push(opts.timeoutMs);
        return '{"winner":"tie","confidence":0.5,"rationale":"r"}';
      },
    };
    await judgeEvaluator.run(namedCtx(judge).ctx);
    expect(seen[0]).toBeLessThanOrEqual(JUDGE_TIMEOUT_MS);
    expect(seen[0]).toBeGreaterThan(0);
  });

  it('reports an error instead of a winner when the judge fails or rambles', async () => {
    const throwing: JudgeRunner = {
      agentId: 'fake',
      model: null,
      ask: async () => {
        throw new Error('judge CLI not authenticated');
      },
    };
    const failed = await judgeEvaluator.run(namedCtx(throwing).ctx);
    expect(failed[0]).toMatchObject({ status: 'error', score: null });
    expect(failed[0]?.summary).toContain('judge CLI not authenticated');

    const rambling = await judgeEvaluator.run(namedCtx(createFakeJudge('they are both good')).ctx);
    expect(rambling[0]).toMatchObject({ status: 'error' });
  });
});
