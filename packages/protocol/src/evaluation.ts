import { z } from 'zod';
import { sideSchema } from './events.js';
import { metricKeySchema, metricValueSchema } from './metrics.js';

/** The efficiency metrics that may break a tie between equally correct sides, all lower-is-better. */
export const EFFICIENCY_METRIC_KEYS = ['tokens_total', 'cost_usd', 'duration_ms'] as const;
export type EfficiencyMetricKey = (typeof EFFICIENCY_METRIC_KEYS)[number];

/**
 * How efficiency breaks a clean tie. Weights are renormalised over the metrics both sides reported,
 * so a missing metric contributes nothing rather than a silent zero. `minAdvantage` is the weighted
 * relative advantage (0..1) a side needs before efficiency may name it the winner; below it the battle
 * is a tie, because a smaller gap is noise on a single run.
 */
export const efficiencyConfigSchema = z.object({
  weights: z
    .object({
      tokens_total: z.number().min(0).max(1).default(0.4),
      cost_usd: z.number().min(0).max(1).default(0.35),
      duration_ms: z.number().min(0).max(1).default(0.25),
    })
    .prefault({}),
  minAdvantage: z.number().min(0).max(1).default(0.05),
});
export type EfficiencyConfig = z.infer<typeof efficiencyConfigSchema>;
export const DEFAULT_EFFICIENCY_CONFIG: EfficiencyConfig = efficiencyConfigSchema.parse({});

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

/** One line of the verdict hierarchy: what each stage found, in the order it was consulted. */
export const verdictBreakdownRowSchema = z.object({
  factor: z.enum(['completion', 'tests', 'regressions', 'assertions', 'build', 'efficiency']),
  /** `a`/`b`: this stage separated the sides; `tie`: it ran and found them equal; `n/a`: it could not run */
  result: z.enum(['a', 'b', 'tie', 'n/a']),
  detail: z.string(),
});
export type VerdictBreakdownRow = z.infer<typeof verdictBreakdownRowSchema>;

/** The efficiency tie-breaker, metric by metric, with the configuration that produced it. */
export const verdictEfficiencySchema = z.object({
  /** `n/a`: no efficiency metric was reported by both sides, or the stage was not consulted */
  winner: z.enum(['a', 'b', 'tie', 'n/a']),
  /** signed weighted relative advantage, positive favours A; 0 when not consulted */
  advantage: z.number(),
  minAdvantage: z.number().min(0).max(1),
  metrics: z.array(
    z.object({
      key: z.enum(EFFICIENCY_METRIC_KEYS),
      a: z.number(),
      b: z.number(),
      /** the configured weight before renormalisation */
      weight: z.number(),
      /** relative advantage for this metric, positive favours A */
      advantage: z.number(),
    }),
  ),
  /** metrics left out, with the reason */
  excluded: z.array(z.object({ key: z.enum(EFFICIENCY_METRIC_KEYS), reason: z.string() })),
});
export type VerdictEfficiency = z.infer<typeof verdictEfficiencySchema>;

export const verdictSchema = z.object({
  winner: z.enum(['a', 'b', 'tie', 'inconclusive']),
  /** 0..1; derived from the number and strength of decisive signals, never invented */
  confidence: z.number().min(0).max(1),
  method: z.enum(['deterministic', 'deterministic+judge', 'insufficient']),
  /** each reason references concrete evidence in the evaluation report */
  reasons: z.array(z.string()),
  decisiveFactors: z.array(z.string()),
  caveats: z.array(z.string()),
  /** the hierarchy, stage by stage; correctness gates first, efficiency only breaks a clean tie */
  breakdown: z.array(verdictBreakdownRowSchema).default([]),
  /** the efficiency stage in full; null when the verdict predates it */
  efficiency: verdictEfficiencySchema.nullable().default(null),
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
