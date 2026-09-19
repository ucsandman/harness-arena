import { z } from 'zod';

export const RATING_CATEGORIES = [
  'overall',
  'debugging',
  'refactoring',
  'greenfield',
  'frontend',
  'backend',
  'long_horizon',
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
  long_horizon: 'Long horizon',
  speed: 'Speed',
  token_efficiency: 'Token efficiency',
  cost_efficiency: 'Cost efficiency',
};

/** community = self-reported local battles; verified = Arena-executed cloud battles. Never mixed. */
export const ratingPoolSchema = z.enum(['community', 'verified']);
export type RatingPool = z.infer<typeof ratingPoolSchema>;

/** Below this many decided battles a rating is shown as provisional and excluded from ranked lists. */
export const RATING_MIN_SAMPLE = 10;
export const RATING_DEFAULT = 1500;
export const RATING_DEFAULT_DEVIATION = 350;

export const ratingSchema = z.object({
  harnessId: z.string(),
  agentId: z.string(),
  category: ratingCategorySchema,
  pool: ratingPoolSchema,
  rating: z.number(),
  deviation: z.number().nonnegative(),
  battles: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  provisional: z.boolean(),
  updatedAt: z.string(),
});
export type Rating = z.infer<typeof ratingSchema>;
