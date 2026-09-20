import { z } from 'zod';
import { arenaEventSchema, battleStatusSchema, EVENT_LIMITS, sideSchema } from './events.js';
import { battleIdSchema } from './ids.js';
import { battleRecordSchema, battleSpecSchema, visibilitySchema } from './battle.js';
import { benchmarkPackSchema } from './benchmarks.js';
import { ratingCategorySchema, ratingPoolSchema } from './ratings.js';

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
