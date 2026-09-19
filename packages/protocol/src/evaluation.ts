import { z } from 'zod';
import { sideSchema } from './events.js';
import { metricKeySchema, metricValueSchema } from './metrics.js';

/** deterministic = reproducible from artifacts; subjective = an LLM opinion, always labeled as such */
export const evaluatorKindSchema = z.enum(['deterministic', 'subjective']);

export const evidenceSchema = z.object({
  label: z.string(),
  a: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  b: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  /** which side this piece of evidence favors */
  favors: z.enum(['a', 'b', 'equal', 'none']),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const evaluatorResultSchema = z.object({
  evaluatorId: z.string(),
  kind: evaluatorKindSchema,
  /** null = compares both sides at once */
  side: sideSchema.nullable(),
  status: z.enum(['passed', 'failed', 'skipped', 'error']),
  /** 0..1 when the evaluator produces a score; null otherwise */
  score: z.number().min(0).max(1).nullable(),
  summary: z.string(),
  details: z.unknown().optional(),
  durationMs: z.number().nonnegative(),
});
export type EvaluatorResult = z.infer<typeof evaluatorResultSchema>;

export const comparisonSchema = z.object({
  key: metricKeySchema,
  label: z.string(),
  a: metricValueSchema,
  b: metricValueSchema,
  better: z.enum(['a', 'b', 'equal', 'n/a']),
  /** decisive: affects the winner; notable: shown prominently; minor: table only */
  significance: z.enum(['decisive', 'notable', 'minor', 'none']),
});
export type Comparison = z.infer<typeof comparisonSchema>;

export const evaluationReportSchema = z.object({
  results: z.array(evaluatorResultSchema),
  comparisons: z.array(comparisonSchema),
  evidence: z.array(evidenceSchema),
  /** evaluators that were requested but could not run, with the reason */
  unavailable: z.array(z.object({ evaluatorId: z.string(), reason: z.string() })).default([]),
  completedAt: z.string(),
});
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;

export const judgeOpinionSchema = z.object({
  winner: z.enum(['a', 'b', 'tie', 'inconclusive']),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  /** the judge saw randomized labels and no harness names */
  blind: z.literal(true),
  subjective: z.literal(true),
  judgeAgent: z.string(),
  judgeModel: z.string().nullable(),
});
export type JudgeOpinion = z.infer<typeof judgeOpinionSchema>;

export const verdictSchema = z.object({
  winner: z.enum(['a', 'b', 'tie', 'inconclusive']),
  /** 0..1; derived from the number and strength of decisive signals, never invented */
  confidence: z.number().min(0).max(1),
  method: z.enum(['deterministic', 'deterministic+judge', 'insufficient']),
  /** each reason references concrete evidence in the evaluation report */
  reasons: z.array(z.string()),
  decisiveFactors: z.array(z.string()),
  caveats: z.array(z.string()),
  judge: judgeOpinionSchema.nullable(),
});
export type Verdict = z.infer<typeof verdictSchema>;

/**
 * A human-readable observation derived from telemetry, e.g.
 * "Harness B found the failing test 37 seconds earlier." Every insight names the events or metrics
 * that support it so the UI can link to them.
 */
export const insightSchema = z.object({
  id: z.string(),
  kind: z.enum(['timing', 'efficiency', 'behavior', 'quality', 'warning']),
  text: z.string(),
  favors: z.enum(['a', 'b', 'equal', 'none']),
  support: z.object({
    metrics: z.array(metricKeySchema).default([]),
    eventSeqs: z.array(z.number().int()).default([]),
  }),
});
export type Insight = z.infer<typeof insightSchema>;
