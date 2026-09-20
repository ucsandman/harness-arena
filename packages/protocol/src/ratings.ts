import { z } from 'zod';

export const RATING_CATEGORIES = [
  'overall',
  'debugging',
  'refactoring',
  'greenfield',
  'frontend',
  'backend',
  'testing',
  'security',
  'repo_navigation',
  'long_horizon',
  'performance',
  'documentation',
  'dependencies',
  'speed',
  'token_efficiency',
  'cost_efficiency',
] as const;
export const ratingCategorySchema = z.enum(RATING_CATEGORIES);
export type RatingCategory = z.infer<typeof ratingCategorySchema>;

export const RATING_CATEGORY_LABELS: Record<RatingCategory, string> = {
  overall: 'Overall',
  debugging: 'Debugging',
  refactoring: 'Refactoring',
  greenfield: 'Greenfield',
  frontend: 'Frontend',
  backend: 'Backend',
  testing: 'Testing',
  security: 'Security',
  repo_navigation: 'Repo navigation',
  long_horizon: 'Long horizon',
  performance: 'Performance',
  documentation: 'Documentation',
  dependencies: 'Dependencies',
  speed: 'Speed',
  token_efficiency: 'Token efficiency',
  cost_efficiency: 'Cost efficiency',
};

/** Categories a benchmark task can declare (every task also counts towards `overall`). */
export const TASK_CATEGORIES = RATING_CATEGORIES.filter(
  (c) => c !== 'overall' && c !== 'speed' && c !== 'token_efficiency' && c !== 'cost_efficiency',
);

/** community = self-reported local battles; verified = Arena-executed cloud battles. Never mixed. */
export const ratingPoolSchema = z.enum(['community', 'verified']);
export type RatingPool = z.infer<typeof ratingPoolSchema>;

export const RATING_POOL_LABELS: Record<RatingPool, string> = {
  community: 'Community',
  verified: 'Verified',
};

/**
 * Glicko-1 constants (Glickman 1999). Ratings start at 1500 with the maximum deviation; the
 * deviation shrinks with evidence and grows again with inactivity, so a stale rating carries a wide
 * interval instead of a stale certainty.
 */
export const RATING_DEFAULT = 1500;
export const RATING_DEFAULT_DEVIATION = 350;
export const RATING_MIN_DEVIATION = 30;
/** deviation growth per day of inactivity: sqrt(RD^2 + c^2 * days), c chosen so ~180 idle days return to 350 from 50 */
export const RATING_DEVIATION_GROWTH_C = 25.8;
/** Below this many decided battles a rating is shown as provisional and excluded from ranked lists. */
export const RATING_MIN_SAMPLE = 10;
/** A ranked rating also needs its deviation under this; otherwise the interval is too wide to order. */
export const RATING_MAX_RANKED_DEVIATION = 120;
/** Recent form window, in battles. */
export const RATING_FORM_WINDOW = 10;

export const ratingSchema = z.object({
  harnessId: z.string(),
  agentId: z.string(),
  category: ratingCategorySchema,
  pool: ratingPoolSchema,
  rating: z.number(),
  deviation: z.number().nonnegative(),
  peakRating: z.number(),
  battles: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  provisional: z.boolean(),
  /** last RATING_FORM_WINDOW outcomes, oldest first: W, L or T */
  form: z.string().regex(/^[WLT]*$/),
  lastBattleAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Rating = z.infer<typeof ratingSchema>;

/** One rating change, as stored for audit and shown as history. */
export const ratingEventSchema = z.object({
  id: z.string(),
  battleId: z.string(),
  harnessId: z.string(),
  harnessVersionId: z.string().nullable(),
  agentId: z.string(),
  category: ratingCategorySchema,
  pool: ratingPoolSchema,
  outcome: z.enum(['win', 'loss', 'tie']),
  opponentHarnessId: z.string(),
  opponentRating: z.number(),
  ratingBefore: z.number(),
  ratingAfter: z.number(),
  deviationBefore: z.number(),
  deviationAfter: z.number(),
  createdAt: z.string(),
});
export type RatingEvent = z.infer<typeof ratingEventSchema>;

export const ratingHistoryPointSchema = z.object({
  battleId: z.string(),
  at: z.string(),
  rating: z.number(),
  deviation: z.number(),
  delta: z.number(),
  outcome: z.enum(['win', 'loss', 'tie']),
  opponentSlug: z.string().nullable(),
  harnessCommit: z.string().nullable(),
});
export type RatingHistoryPoint = z.infer<typeof ratingHistoryPointSchema>;

/** The verified pool's standardisation requirements, in the order the UI lists them. */
export const VERIFIED_REQUIREMENTS = [
  { key: 'executor', label: 'Executed by Arena in a controlled sandbox, not on a contributor machine' },
  { key: 'task', label: 'Same task definition and benchmark version for every entrant' },
  { key: 'agent', label: 'Same agent CLI and version' },
  { key: 'model', label: 'Same model where the agent lets Arena set it' },
  { key: 'limits', label: 'Same limits (timeout, turns, budget)' },
  { key: 'repository', label: 'Same repository commit' },
  { key: 'harness', label: 'Harness pinned to an exact commit' },
  { key: 'evaluator', label: 'Same evaluator version' },
  { key: 'environment', label: 'Identical environment image' },
] as const;
