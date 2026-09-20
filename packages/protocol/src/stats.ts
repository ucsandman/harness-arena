import { z } from 'zod';

/**
 * Descriptive statistics over repeated runs. Every summary carries its sample size so no consumer can
 * present a single run as a distribution. Intervals are null below the minimum sample.
 */

export const statsSummarySchema = z.object({
  n: z.number().int().nonnegative(),
  mean: z.number().nullable(),
  median: z.number().nullable(),
  variance: z.number().nullable(),
  stddev: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** 95% interval for the mean (t-distribution); null when n < STATS_MIN_INTERVAL_SAMPLE */
  ci95: z.tuple([z.number(), z.number()]).nullable(),
});
export type StatsSummary = z.infer<typeof statsSummarySchema>;

/** A proportion with its Wilson score interval. */
export const rateSummarySchema = z.object({
  n: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1).nullable(),
  ci95: z.tuple([z.number(), z.number()]).nullable(),
});
export type RateSummary = z.infer<typeof rateSummarySchema>;

/** Control vs treatment on one numeric metric, over the battles where both sides reported it. */
export const metricDeltaSchema = z.object({
  control: statsSummarySchema,
  treatment: statsSummarySchema,
  /** (treatment mean - control mean) / control mean; null when either mean is missing or zero */
  deltaPercent: z.number().nullable(),
  /** paired battles that contributed */
  n: z.number().int().nonnegative(),
});
export type MetricDelta = z.infer<typeof metricDeltaSchema>;

/** Plain-language confidence that a summary generalises, with the arithmetic behind it. */
export const evidenceStrengthSchema = z.object({
  level: z.enum(['none', 'low', 'medium', 'high']),
  /** the sample the level was derived from */
  n: z.number().int().nonnegative(),
  rationale: z.string(),
});
export type EvidenceStrength = z.infer<typeof evidenceStrengthSchema>;

export const STATS_MIN_INTERVAL_SAMPLE = 3;
/** below this many comparable battles a conclusion is labelled `low` at best */
export const STATS_LOW_SAMPLE = 5;
export const STATS_MEDIUM_SAMPLE = 10;
export const STATS_HIGH_SAMPLE = 30;
