import { z } from 'zod';

/**
 * Every metric says where it came from. The UI never shows a number without its status.
 *
 * - observed:    reported directly by the agent CLI (e.g. Claude Code's `usage` block)
 * - calculated:  derived by Arena from observed data (e.g. lines changed from `git diff --numstat`)
 * - estimated:   a heuristic, always labeled (e.g. cost computed from list prices when the CLI gives none)
 * - unavailable: the CLI does not expose it; the value is null and the UI shows "n/a", never 0
 */
export const metricStatusSchema = z.enum(['observed', 'calculated', 'estimated', 'unavailable']);
export type MetricStatus = z.infer<typeof metricStatusSchema>;

export const metricValueSchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  status: metricStatusSchema,
  /** Which adapter/evaluator produced it, e.g. "claude-code:result.usage" or "core:git-diff". */
  source: z.string().optional(),
  unit: z.string().optional(),
  note: z.string().optional(),
});
export type MetricValue = z.infer<typeof metricValueSchema>;

export const METRIC_KEYS = [
  'completion_status',
  'tests_passed',
  'tests_failed',
  'tests_total',
  'regressions',
  'duration_ms',
  'tokens_input',
  'tokens_output',
  'tokens_cache_read',
  'tokens_cache_write',
  'tokens_total',
  'cost_usd',
  'model_requests',
  'tool_calls',
  'commands_run',
  'files_inspected',
  'files_changed',
  'lines_added',
  'lines_removed',
  'turns',
  'subagents_spawned',
  'retries',
  'errors',
  'human_interventions',
  'context_compactions',
  'exit_code',
] as const;

export const metricKeySchema = z.enum(METRIC_KEYS);
export type MetricKey = z.infer<typeof metricKeySchema>;

export const METRIC_LABELS: Record<MetricKey, string> = {
  completion_status: 'Completion',
  tests_passed: 'Tests passed',
  tests_failed: 'Tests failed',
  tests_total: 'Tests total',
  regressions: 'Regressions',
  duration_ms: 'Duration',
  tokens_input: 'Input tokens',
  tokens_output: 'Output tokens',
  tokens_cache_read: 'Cache read tokens',
  tokens_cache_write: 'Cache write tokens',
  tokens_total: 'Tokens',
  cost_usd: 'Cost',
  model_requests: 'Model requests',
  tool_calls: 'Tool calls',
  commands_run: 'Commands',
  files_inspected: 'Files inspected',
  files_changed: 'Files changed',
  lines_added: 'Lines added',
  lines_removed: 'Lines removed',
  turns: 'Agent turns',
  subagents_spawned: 'Subagents',
  retries: 'Retries',
  errors: 'Errors',
  human_interventions: 'Human input',
  context_compactions: 'Context compactions',
  exit_code: 'Exit status',
};

/** For each metric, is a lower value better, higher better, or is it not comparable? */
export const METRIC_DIRECTION: Record<MetricKey, 'lower' | 'higher' | 'none'> = {
  completion_status: 'none',
  tests_passed: 'higher',
  tests_failed: 'lower',
  tests_total: 'none',
  regressions: 'lower',
  duration_ms: 'lower',
  tokens_input: 'lower',
  tokens_output: 'lower',
  tokens_cache_read: 'none',
  tokens_cache_write: 'none',
  tokens_total: 'lower',
  cost_usd: 'lower',
  model_requests: 'lower',
  tool_calls: 'none',
  commands_run: 'none',
  files_inspected: 'none',
  files_changed: 'none',
  lines_added: 'none',
  lines_removed: 'none',
  turns: 'lower',
  subagents_spawned: 'none',
  retries: 'lower',
  errors: 'lower',
  human_interventions: 'lower',
  context_compactions: 'lower',
  exit_code: 'none',
};

export const runMetricsSchema = z.record(metricKeySchema, metricValueSchema);
export type RunMetrics = Record<MetricKey, MetricValue>;

export function unavailable(note?: string): MetricValue {
  return { value: null, status: 'unavailable', ...(note ? { note } : {}) };
}

export function emptyMetrics(): RunMetrics {
  const out = {} as RunMetrics;
  for (const k of METRIC_KEYS) out[k] = unavailable();
  return out;
}

export function observed(value: number | string | boolean, source: string, extra?: Partial<MetricValue>): MetricValue {
  return { value, status: 'observed', source, ...extra };
}

export function calculated(
  value: number | string | boolean,
  source: string,
  extra?: Partial<MetricValue>,
): MetricValue {
  return { value, status: 'calculated', source, ...extra };
}

export function estimated(value: number | string | boolean, source: string, note: string): MetricValue {
  return { value, status: 'estimated', source, note };
}
