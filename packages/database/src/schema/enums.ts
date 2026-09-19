import { pgEnum } from 'drizzle-orm/pg-core';
import {
  artifactKindSchema,
  battleStatusSchema,
  eventConfidenceSchema,
  executionModeSchema,
  inspectionFrameworkSchema,
  metricStatusSchema,
  ratingCategorySchema,
  ratingPoolSchema,
  runStatusSchema,
  sideSchema,
  visibilitySchema,
} from '@harness-arena/protocol';

/**
 * Every enum in the database mirrors a protocol schema so the two can never drift: the values come
 * straight from the zod schema's options. Enums defined only here (plans, device-code status) have no
 * protocol counterpart because they never cross the CLI boundary.
 */
function values<T extends string>(options: readonly T[]): [T, ...T[]] {
  return options as unknown as [T, ...T[]];
}

export const userPlanEnum = pgEnum('user_plan', ['free', 'pro', 'team']);
export const deviceCodeStatusEnum = pgEnum('device_code_status', [
  'pending',
  'approved',
  'denied',
  'expired',
]);

export const battleStatusEnum = pgEnum('battle_status', values(battleStatusSchema.options));
export const runStatusEnum = pgEnum('run_status', values(runStatusSchema.options));
export const sideEnum = pgEnum('battle_side', values(sideSchema.options));
export const visibilityEnum = pgEnum('visibility', values(visibilitySchema.options));
export const executionModeEnum = pgEnum('execution_mode', values(executionModeSchema.options));
export const eventConfidenceEnum = pgEnum('event_confidence', values(eventConfidenceSchema.options));
export const metricStatusEnum = pgEnum('metric_status', values(metricStatusSchema.options));
export const artifactKindEnum = pgEnum('artifact_kind', values(artifactKindSchema.options));
export const ratingPoolEnum = pgEnum('rating_pool', values(ratingPoolSchema.options));
export const ratingCategoryEnum = pgEnum('rating_category', values(ratingCategorySchema.options));
export const harnessFrameworkEnum = pgEnum('harness_framework', values(inspectionFrameworkSchema.options));

/** local = self-reported by a user's machine; cloud = executed by Arena in a controlled sandbox. */
export const verificationKindEnum = pgEnum('verification_kind', ['local', 'cloud']);
export const harnessSourceKindEnum = pgEnum('harness_source_kind', ['vanilla', 'github', 'git', 'local']);
export const repositoryKindEnum = pgEnum('repository_kind', ['github', 'git', 'local', 'empty']);
export const taskKindEnum = pgEnum('task_kind', ['prompt', 'issue', 'demo']);
export const battleWinnerEnum = pgEnum('battle_winner', ['a', 'b', 'tie', 'inconclusive']);
