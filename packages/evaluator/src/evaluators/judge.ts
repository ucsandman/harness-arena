import { z } from 'zod';
import type { EvaluatorResult, JudgeOpinion, Side } from '@harness-arena/protocol';
import type { Evaluator, EvaluationContext, JudgeRunner } from '../types.js';
import { makeResult } from './shared.js';

export const JUDGE_ID = 'judge';

/** Per-side diff budget in the judge prompt. */
export const JUDGE_DIFF_CAP_BYTES = 60 * 1024;
/** Per-side final response budget in the judge prompt. */
export const JUDGE_RESPONSE_CAP_BYTES = 20 * 1024;
/** Task prompt budget in the judge prompt. */
export const JUDGE_TASK_CAP_BYTES = 8 * 1024;
/** Hard ceiling for one judge call. */
export const JUDGE_TIMEOUT_MS = 300_000;

export const DEFAULT_RUBRIC = [
  '1. Correctness: does the change actually accomplish the task, without breaking anything else?',
  '2. Completeness: is every part of the task addressed, with no placeholder or stubbed work?',
  '3. Restraint: is the change scoped to the task, with no unrelated rewrites or deletions?',
  '4. Quality: does the code read like the rest of the project and handle obvious failure cases?',
].join('\n');

/** Blind label pair. The mapping to sides is randomized per battle and recorded in the result. */
export type JudgeLabel = 'X' | 'Y';
export type JudgeLabels = Record<JudgeLabel, Side>;

/** Words too generic to redact from a diff; redacting them would mangle unrelated code. */
const SCRUB_DENYLIST = new Set(['fake', 'vanilla', 'main', 'test', 'tests', 'local', 'demo', 'node']);

function capText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = text.slice(0, maxBytes);
  while (out.length > 0 && Buffer.byteLength(out) > maxBytes)
    out = out.slice(0, Math.floor(out.length * 0.9));
  return `${out}\n[truncated at ${maxBytes} bytes]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Identity tokens that would tell the judge which harness or agent produced a candidate. */
export function identityTokens(ctx: EvaluationContext): string[] {
  const { a, b } = ctx.spec.competitors;
  const raw = [
    a.label,
    b.label,
    a.harness.source,
    b.harness.source,
    a.agent.id,
    b.agent.id,
    a.agent.model,
    b.agent.model,
  ];
  const tokens = new Set<string>();
  for (const value of raw) {
    if (!value) continue;
    for (const piece of [value, ...value.split(/[\s/\\]+/)]) {
      const token = piece.trim();
      if (token.length < 4) continue;
      if (SCRUB_DENYLIST.has(token.toLowerCase())) continue;
      tokens.add(token);
    }
  }
  return [...tokens].sort((x, y) => y.length - x.length);
}

/** Removes identity tokens from text that goes to the judge. Blindness is enforced, not requested. */
export function scrubIdentity(text: string, tokens: readonly string[]): string {
  let out = text;
  for (const token of tokens) out = out.replace(new RegExp(escapeRegExp(token), 'gi'), '[redacted]');
  return out;
}

export function pickLabels(random: () => number = Math.random): JudgeLabels {
  return random() < 0.5 ? { X: 'a', Y: 'b' } : { X: 'b', Y: 'a' };
}

function candidateBlock(
  label: JudgeLabel,
  ctx: EvaluationContext,
  labels: JudgeLabels,
  tokens: string[],
): string {
  const side = labels[label];
  const sideCtx = ctx.sides[side];
  const response = sideCtx.finalResponse ?? sideCtx.artifacts.finalResponse ?? '(no final message)';
  const diff = sideCtx.artifacts.diff ?? '(no diff captured)';
  return [
    `## Candidate ${label}`,
    '',
    `### Candidate ${label} summary of its own work`,
    scrubIdentity(capText(response, JUDGE_RESPONSE_CAP_BYTES), tokens),
    '',
    `### Candidate ${label} diff`,
    '~~~diff',
    scrubIdentity(capText(diff, JUDGE_DIFF_CAP_BYTES), tokens),
    '~~~',
  ].join('\n');
}

/**
 * Builds the blind prompt. It contains the task, both candidates' diffs and self-reports, and a rubric.
 * It contains no harness name, no agent name, no model name and no side letters: only Candidate X and
 * Candidate Y, in a randomized order.
 */
export function buildJudgePrompt(ctx: EvaluationContext, labels: JudgeLabels): string {
  const tokens = identityTokens(ctx);
  const rubric = ctx.spec.evaluation.judge.rubric ?? DEFAULT_RUBRIC;
  return [
    'You are an impartial code reviewer comparing two anonymous attempts at the same software task.',
    'You do not know who or what produced either candidate, and you must not speculate about it.',
    '',
    '## Task given to both candidates',
    scrubIdentity(ctx.task.title, tokens),
    '',
    scrubIdentity(capText(ctx.task.prompt, JUDGE_TASK_CAP_BYTES), tokens),
    '',
    '## Rubric, in priority order',
    rubric,
    '',
    candidateBlock('X', ctx, labels, tokens),
    '',
    candidateBlock('Y', ctx, labels, tokens),
    '',
    '## Required answer format',
    'Reply with one JSON object and nothing else. No prose, no code fence, no markdown:',
    '{"winner": "X" | "Y" | "tie", "confidence": <number between 0 and 1>, "rationale": "<one or two sentences>"}',
  ].join('\n');
}

const judgeAnswerSchema = z.object({
  winner: z.enum(['X', 'Y', 'tie']),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

function extractJsonObject(text: string): unknown {
  const withoutFence = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface JudgeAnswer {
  winner: 'a' | 'b' | 'tie';
  confidence: number;
  rationale: string;
}

/**
 * Reads the judge's reply. Tolerant about wrapping (code fences, surrounding prose) and about casing,
 * strict about the shape: anything else is an error, never a guessed winner.
 */
export function parseJudgeResponse(text: string, labels: JudgeLabels): JudgeAnswer | { error: string } {
  const raw = extractJsonObject(text);
  if (raw === null || typeof raw !== 'object') return { error: 'judge reply contained no JSON object' };
  const record = raw as Record<string, unknown>;
  const winnerRaw = typeof record.winner === 'string' ? record.winner.trim().toUpperCase() : '';
  const winner = winnerRaw === 'TIE' ? 'tie' : winnerRaw;
  const confidenceRaw = typeof record.confidence === 'string' ? Number(record.confidence) : record.confidence;
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? confidenceRaw : 0.5;
  const parsed = judgeAnswerSchema.safeParse({
    winner,
    confidence: Math.min(1, Math.max(0, confidence)),
    rationale: typeof record.rationale === 'string' ? record.rationale : '',
  });
  if (!parsed.success) {
    return {
      error: `judge reply did not match the required shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  const answer = parsed.data;
  return {
    winner: answer.winner === 'tie' ? 'tie' : labels[answer.winner],
    confidence: answer.confidence,
    rationale: answer.rationale,
  };
}

export type FakeJudge = JudgeRunner & { prompts: string[] };

/** Test double: returns `answer` for every question and keeps the prompts it was asked. */
export function createFakeJudge(
  answer: string,
  opts?: { agentId?: string; model?: string | null },
): FakeJudge {
  const prompts: string[] = [];
  return {
    agentId: opts?.agentId ?? 'fake',
    model: opts?.model ?? null,
    prompts,
    async ask(prompt: string) {
      prompts.push(prompt);
      return answer;
    },
  };
}

/**
 * The optional blind LLM judge. Subjective by construction and labeled as such everywhere: the verdict
 * engine never lets it override deterministic evidence. The judge model is run by the caller's own
 * authenticated CLI (ctx.judge), so Arena still pays for nothing.
 */
export const judgeEvaluator: Evaluator = {
  id: JUDGE_ID,
  kind: 'subjective',
  applies: (ctx) => ctx.spec.evaluation.judge.enabled && ctx.judge !== undefined,
  async run(ctx) {
    const judge = ctx.judge;
    if (!judge) return [];
    const startedAt = Date.now();
    const labels = pickLabels();
    const prompt = buildJudgePrompt(ctx, labels);
    ctx.logger.debug('judge asked', {
      judgeAgent: judge.agentId,
      labels,
      promptBytes: Buffer.byteLength(prompt),
    });

    let reply: string;
    try {
      reply = await judge.ask(prompt, {
        signal: ctx.signal,
        timeoutMs: Math.min(ctx.spec.limits.timeoutMs, JUDGE_TIMEOUT_MS),
      });
    } catch (err) {
      return [
        makeResult(
          {
            evaluatorId: JUDGE_ID,
            kind: 'subjective',
            side: null,
            status: 'error',
            score: null,
            summary: `judge failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          startedAt,
        ),
      ];
    }

    const answer = parseJudgeResponse(reply, labels);
    if ('error' in answer) {
      return [
        makeResult(
          {
            evaluatorId: JUDGE_ID,
            kind: 'subjective',
            side: null,
            status: 'error',
            score: null,
            summary: answer.error,
          },
          startedAt,
        ),
      ];
    }

    const opinion: JudgeOpinion = {
      winner: answer.winner,
      confidence: answer.confidence,
      rationale: answer.rationale,
      blind: true,
      subjective: true,
      judgeAgent: judge.agentId,
      judgeModel: judge.model,
    };

    const result: EvaluatorResult = makeResult(
      {
        evaluatorId: JUDGE_ID,
        kind: 'subjective',
        side: null,
        status: 'passed',
        score: null,
        summary: `judge preferred ${answer.winner === 'tie' ? 'neither side' : `side ${answer.winner}`} (subjective)`,
        details: { ...opinion, labels },
      },
      startedAt,
    );
    return [result];
  },
};
