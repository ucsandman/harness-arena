import { z } from 'zod';
import { arenaEventSchema, battleStatusSchema, EVENT_LIMITS, sideSchema } from './events.js';
import { battleIdSchema } from './ids.js';
import { battleRecordSchema, battleSpecSchema, visibilitySchema } from './battle.js';
import { benchmarkPackSchema } from './benchmarks.js';
import { lineageEdgeSchema } from './arena.js';
import { ratingCategorySchema, ratingHistoryPointSchema, ratingPoolSchema } from './ratings.js';

/**
 * HTTP contract between the CLI and the web app. All endpoints live under /api/v1.
 * Authentication: `Authorization: Bearer <device token>` issued by the device flow.
 */

export const API_LIMITS = {
  maxArtifactBytes: 2 * 1024 * 1024,
  maxBatchEvents: EVENT_LIMITS.maxBatchEvents,
  maxBodyBytes: 4 * 1024 * 1024,
} as const;

// ---- device login (RFC 8628-style) ----------------------------------------------------------

export const deviceCodeRequestSchema = z.object({
  /** human-readable device name shown in the account's device list */
  deviceName: z.string().min(1).max(80),
  arenaVersion: z.string().max(40),
});
export const deviceCodeResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export const deviceTokenRequestSchema = z.object({ deviceCode: z.string().min(16).max(200) });
export const deviceTokenResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    token: z.string(),
    tokenPrefix: z.string(),
    user: z.object({ id: z.string(), login: z.string(), name: z.string().nullable() }),
  }),
]);
export type DeviceTokenResponse = z.infer<typeof deviceTokenResponseSchema>;

export const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    login: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  device: z.object({ id: z.string(), name: z.string(), createdAt: z.string() }),
});

// ---- battles ----------------------------------------------------------------------------------

/** Create (or claim a pending) battle. The record is the source of truth; spec alone creates a pending battle. */
export const createBattleRequestSchema = z.object({
  record: battleRecordSchema.optional(),
  spec: battleSpecSchema.optional(),
  visibility: visibilitySchema.optional(),
});
export const createBattleResponseSchema = z.object({
  id: battleIdSchema,
  url: z.string(),
  streamUrl: z.string(),
});

export const patchBattleRequestSchema = z.object({
  record: battleRecordSchema.optional(),
  status: battleStatusSchema.optional(),
  visibility: visibilitySchema.optional(),
});

export const ingestEventsRequestSchema = z.object({
  events: z.array(arenaEventSchema).min(1).max(API_LIMITS.maxBatchEvents),
});
export const ingestEventsResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative().nullable(),
  /** server stopped storing events for this battle (cap reached) */
  capped: z.boolean(),
});

export const artifactKindSchema = z.enum(['diff', 'final_response', 'report_html']);
export const uploadArtifactRequestSchema = z.object({
  side: sideSchema.nullable(),
  kind: artifactKindSchema,
  content: z.string().max(API_LIMITS.maxArtifactBytes),
  contentType: z.string().max(100).default('text/plain'),
});

export const battleListItemSchema = z.object({
  id: battleIdSchema,
  title: z.string(),
  status: battleStatusSchema,
  visibility: visibilitySchema,
  winner: z.enum(['a', 'b', 'tie', 'inconclusive']).nullable(),
  a: z.object({ label: z.string(), agent: z.string(), harness: z.string() }),
  b: z.object({ label: z.string(), agent: z.string(), harness: z.string() }),
  demo: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type BattleListItem = z.infer<typeof battleListItemSchema>;

/** GET /api/v1/battles/:id; `events` and `truncated` only with ?events=1 */
export const battleDetailResponseSchema = z.object({
  record: battleRecordSchema,
  eventCount: z.number().int().nonnegative(),
  eventsCapped: z.boolean(),
  events: z.array(arenaEventSchema).optional(),
  truncated: z.boolean().optional(),
  /** stored events that no longer parse against the current protocol and were left out */
  invalid: z.number().int().nonnegative().optional(),
});
export type BattleDetailResponse = z.infer<typeof battleDetailResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Server-sent event names on GET /api/v1/battles/:id/stream */
export const SSE_EVENT_NAMES = ['event', 'record', 'heartbeat', 'end'] as const;

// ---- arena ------------------------------------------------------------------------------------

/** POST /api/v1/benchmarks: publish a pack version. Re-publishing identical content is a no-op. */
export const uploadBenchmarkRequestSchema = z.object({ pack: benchmarkPackSchema });
export const uploadBenchmarkResponseSchema = z.object({
  versionId: z.string(),
  slug: z.string(),
  version: z.string(),
  created: z.boolean(),
  url: z.string(),
});

/** GET /api/v1/leaderboard */
export const leaderboardEntrySchema = z.object({
  rank: z.number().int().positive().nullable(),
  harnessSlug: z.string(),
  harnessName: z.string(),
  agentId: z.string(),
  rating: z.number(),
  deviation: z.number(),
  peakRating: z.number(),
  battles: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  provisional: z.boolean(),
  form: z.string(),
  lastBattleAt: z.string().nullable(),
});
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

export const leaderboardResponseSchema = z.object({
  category: ratingCategorySchema,
  pool: ratingPoolSchema,
  agentId: z.string().nullable(),
  minSample: z.number().int(),
  entries: z.array(leaderboardEntrySchema),
  /** true when the pool holds nothing at all, so the page can say so instead of showing an empty table */
  poolEmpty: z.boolean(),
});
export type LeaderboardResponse = z.infer<typeof leaderboardResponseSchema>;

/** POST /api/v1/experiments/:id/battles and friends: link an uploaded battle to an arena object. */
export const linkBattleRequestSchema = z.object({ battleId: battleIdSchema });

// ---- harness profile, rating history, badges ----------------------------------------------------
//
// Appended by the competitive web workstream. These are the read shapes behind
// /api/v1/harnesses/:slug, /api/v1/harnesses/:slug/history and /api/v1/badges/:slug/:kind, and they
// are what the CLI's read commands parse. Every derived number travels with the sample it was
// computed over (`n`, `battles`, `correctnessBattles`, `analyzedBattles`) so no consumer can render a
// rate without its denominator, and a rating below the minimum sample is marked `provisional`.

/** One (agent, category, pool) rating row. `pool` is never mixed: community and verified stay apart. */
export const harnessRatingSchema = z.object({
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
  /** last outcomes, oldest first, as W/L/T */
  form: z.string().regex(/^[WLT]*$/),
  lastBattleAt: z.string().nullable(),
});
export type HarnessRating = z.infer<typeof harnessRatingSchema>;

/** A commit of the harness and the record it earned. `commit` is null for an unpinned local harness. */
export const harnessVersionSummarySchema = z.object({
  id: z.string(),
  commit: z.string().nullable(),
  createdAt: z.string(),
  battles: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
});
export type HarnessVersionSummary = z.infer<typeof harnessVersionSummarySchema>;

export const harnessCategoryPerformanceSchema = z.object({
  category: ratingCategorySchema,
  battles: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  /** share of `correctnessBattles` where this harness won or tied every correctness gate that ran */
  correctnessRate: z.number().min(0).max(1).nullable(),
  /** the denominator; a rate over nothing is null, never 0 */
  correctnessBattles: z.number().int().nonnegative(),
});
export type HarnessCategoryPerformanceEntry = z.infer<typeof harnessCategoryPerformanceSchema>;

/** Median of (this harness / the opponent) on one metric, over the battles where both reported it. */
export const efficiencyRatioSchema = z.object({
  medianRatio: z.number().nullable(),
  n: z.number().int().nonnegative(),
});
export type EfficiencyRatio = z.infer<typeof efficiencyRatioSchema>;

export const harnessEfficiencyProfileSchema = z.object({
  tokens: efficiencyRatioSchema,
  cost: efficiencyRatioSchema,
  duration: efficiencyRatioSchema,
});
export type HarnessEfficiencyProfile = z.infer<typeof harnessEfficiencyProfileSchema>;

/** A harness this one has actually fought, with the record between them. */
export const harnessOpponentSchema = z.object({
  slug: z.string(),
  name: z.string(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
});
export type HarnessOpponent = z.infer<typeof harnessOpponentSchema>;

export const harnessInsightKindSchema = z.enum([
  'category_strength',
  'category_weakness',
  'version_delta',
  'efficiency',
]);
export type HarnessInsightKind = z.infer<typeof harnessInsightKindSchema>;

/** A sentence derived from the numbers above; `n` is the sample it rests on and is always shown. */
export const harnessInsightSchema = z.object({
  kind: harnessInsightKindSchema,
  text: z.string(),
  n: z.number().int().nonnegative(),
});
export type HarnessInsightEntry = z.infer<typeof harnessInsightSchema>;

/** GET /api/v1/harnesses/:slug — everything the profile page renders, public data only. */
export const harnessProfileResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  sourceUrl: z.string().nullable(),
  sourceKind: z.string(),
  description: z.string().nullable(),
  framework: z.string(),
  /** GitHub login of the account that imported it, when it has one */
  owner: z.string().nullable(),
  ratings: z.array(harnessRatingSchema),
  versions: z.array(harnessVersionSummarySchema),
  categoryPerformance: z.array(harnessCategoryPerformanceSchema),
  efficiencyProfile: harnessEfficiencyProfileSchema,
  recentBattles: z.array(battleListItemSchema),
  opponents: z.array(harnessOpponentSchema),
  lineage: z.object({
    ancestors: z.array(lineageEdgeSchema),
    descendants: z.array(lineageEdgeSchema),
  }),
  insights: z.array(harnessInsightSchema),
  /** public challenges naming this harness on either side */
  challenges: z.number().int().nonnegative(),
  /** decided public battles the category and efficiency sections were computed over */
  analyzedBattles: z.number().int().nonnegative(),
});
export type HarnessProfileResponse = z.infer<typeof harnessProfileResponseSchema>;

/** GET /api/v1/harnesses/:slug/history — the rating curve, straight off the audit trail. */
export const ratingHistoryResponseSchema = z.object({
  slug: z.string(),
  agentId: z.string().nullable(),
  category: ratingCategorySchema,
  pool: ratingPoolSchema,
  points: z.array(ratingHistoryPointSchema),
});
export type RatingHistoryResponse = z.infer<typeof ratingHistoryResponseSchema>;

/**
 * GET /api/v1/badges/:slug/:kind — an SVG a README can embed. Every kind states its sample or says
 * `provisional`; `verified-rating` reads "no verified battles" while no hosted runner exists.
 */
export const badgeKindSchema = z.enum([
  'rating',
  'verified-rating',
  'win-rate',
  'correctness',
  'battles',
  'tokens',
  'top',
]);
export type BadgeKind = z.infer<typeof badgeKindSchema>;

export const BADGE_KINDS = badgeKindSchema.options;

export const BADGE_KIND_LABELS: Record<BadgeKind, string> = {
  rating: 'Community rating',
  'verified-rating': 'Verified rating',
  'win-rate': 'Win rate',
  correctness: 'Correctness rate',
  battles: 'Battles',
  tokens: 'Token efficiency',
  top: 'Category rank',
};
