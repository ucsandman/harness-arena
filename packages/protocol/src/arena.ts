import { z } from 'zod';
import {
  agentRefSchema,
  evaluationSpecSchema,
  harnessRefSchema,
  limitsSchema,
  privacySettingsSchema,
  repositorySpecSchema,
  taskSpecSchema,
  visibilitySchema,
} from './battle.js';
import { benchmarkSlugSchema, benchmarkTaskIdSchema } from './benchmarks.js';
import { ratingCategorySchema, ratingPoolSchema } from './ratings.js';
import { evidenceStrengthSchema, metricDeltaSchema, rateSummarySchema } from './stats.js';

/**
 * The competitive layer: challenges, experiments, tournaments, bounties, lineage, components.
 *
 * Nothing here executes anything. Every battle is still run locally by whoever accepts the work, with
 * the CLI the user already has; the server holds the definition, links the uploaded battles, and
 * labels every result community. That is stated on every page and in every API response.
 */

// ---- shared refs --------------------------------------------------------------------------------

/** A harness as a competitor: the ref the CLI resolves, plus an optional display label. */
export const competitorRefSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  harness: harnessRefSchema,
});
export type CompetitorRef = z.infer<typeof competitorRefSchema>;

/** What to run: a whole pack, one task of a pack, or an inline task. */
export const workTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('benchmark'),
    slug: benchmarkSlugSchema,
    versionId: z.string().regex(/^bmv_[0-9a-f]{24}$/),
    /** run one task only */
    taskId: benchmarkTaskIdSchema.optional(),
  }),
  z.object({
    kind: z.literal('task'),
    title: z.string().max(200).optional(),
    category: ratingCategorySchema.default('overall'),
    task: taskSpecSchema,
    repository: repositorySpecSchema,
    evaluation: evaluationSpecSchema.prefault({}),
    limits: limitsSchema.prefault({}),
  }),
]);
export type WorkTarget = z.infer<typeof workTargetSchema>;

// ---- challenges ---------------------------------------------------------------------------------

export const challengeStatusSchema = z.enum(['open', 'accepted', 'completed', 'cancelled', 'expired']);
export type ChallengeStatus = z.infer<typeof challengeStatusSchema>;

export const challengeSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable(),
  status: challengeStatusSchema,
  createdBy: z.object({ id: z.string(), login: z.string() }).nullable(),
  sides: z.object({ a: competitorRefSchema, b: competitorRefSchema }),
  agent: agentRefSchema,
  target: workTargetSchema,
  privacy: privacySettingsSchema,
  visibility: visibilitySchema,
  /** whether a decided result may move community ratings (integrity checks still apply) */
  ratingEligible: z.boolean(),
  /** battles uploaded against this challenge */
  battleIds: z.array(z.string()),
  /** the user who accepted it (runs it locally), if anyone */
  acceptedBy: z.object({ id: z.string(), login: z.string() }).nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type Challenge = z.infer<typeof challengeSchema>;

export const createChallengeRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  sides: z.object({ a: competitorRefSchema, b: competitorRefSchema }),
  agent: agentRefSchema,
  target: workTargetSchema,
  privacy: privacySettingsSchema.prefault({}),
  visibility: visibilitySchema.default('public'),
  ratingEligible: z.boolean().default(true),
  /** ISO timestamp; omitted = no deadline */
  expiresAt: z.string().optional(),
});
export type CreateChallengeRequest = z.infer<typeof createChallengeRequestSchema>;

// ---- experiments --------------------------------------------------------------------------------

/**
 * regression: previous commit (control) vs current commit (treatment) of one harness.
 * ablation:   the same harness with one component removed (control) vs present (treatment).
 * comparison: two unrelated harnesses.
 */
export const experimentKindSchema = z.enum(['regression', 'ablation', 'comparison']);
export type ExperimentKind = z.infer<typeof experimentKindSchema>;

export const experimentStatusSchema = z.enum(['planned', 'running', 'completed', 'failed', 'cancelled']);
export type ExperimentStatus = z.infer<typeof experimentStatusSchema>;

export const componentKindSchema = z.enum([
  'harness',
  'instructions',
  'skill',
  'hook',
  'mcp',
  'subagent',
  'prompt',
  'settings',
  'memory',
  'benchmark',
]);
export type ComponentKind = z.infer<typeof componentKindSchema>;

export const COMPONENT_KIND_LABELS: Record<ComponentKind, string> = {
  harness: 'Harness',
  instructions: 'Instructions file',
  skill: 'Skill',
  hook: 'Hook',
  mcp: 'MCP server',
  subagent: 'Subagent',
  prompt: 'Prompt pack',
  settings: 'Settings',
  memory: 'Memory system',
  benchmark: 'Benchmark pack',
};

/** The one thing that differs between control and treatment. Required for an ablation. */
export const changedComponentSchema = z.object({
  kind: componentKindSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  /** repository-relative path of the component in the treatment harness, when it is a file */
  path: z.string().max(500).optional(),
});
export type ChangedComponent = z.infer<typeof changedComponentSchema>;

export const experimentSummarySchema = z.object({
  /** battles that reached a verdict */
  battles: z.number().int().nonnegative(),
  /** battles where both sides completed, so metrics are paired */
  comparable: z.number().int().nonnegative(),
  wins: z.object({
    control: z.number().int().nonnegative(),
    treatment: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    inconclusive: z.number().int().nonnegative(),
  }),
  /** a side is "correct" on a battle when it passed every correctness gate that ran */
  correctness: z.object({
    control: rateSummarySchema,
    treatment: rateSummarySchema,
    /** percentage points, treatment minus control */
    deltaPoints: z.number().nullable(),
  }),
  tokens: metricDeltaSchema,
  cost: metricDeltaSchema,
  duration: metricDeltaSchema,
  /** per category, same shape as the top level minus the metrics */
  byCategory: z.array(
    z.object({
      category: ratingCategorySchema,
      battles: z.number().int().nonnegative(),
      correctness: z.object({
        control: rateSummarySchema,
        treatment: rateSummarySchema,
        deltaPoints: z.number().nullable(),
      }),
    }),
  ),
  evidence: evidenceStrengthSchema,
  /** plain sentences derived from the numbers above; every one names its sample */
  conclusions: z.array(z.string()),
});
export type ExperimentSummary = z.infer<typeof experimentSummarySchema>;

export const experimentSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  kind: experimentKindSchema,
  status: experimentStatusSchema,
  createdBy: z.object({ id: z.string(), login: z.string() }).nullable(),
  control: competitorRefSchema,
  treatment: competitorRefSchema,
  changedComponent: changedComponentSchema.nullable(),
  agent: agentRefSchema,
  target: workTargetSchema,
  /** trials per task, on top of the pack's own trial count */
  trials: z.number().int().min(1).max(20),
  visibility: visibilitySchema,
  battleIds: z.array(z.string()),
  summary: experimentSummarySchema.nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Experiment = z.infer<typeof experimentSchema>;

export const createExperimentRequestSchema = z.object({
  title: z.string().min(1).max(200),
  kind: experimentKindSchema,
  control: competitorRefSchema,
  treatment: competitorRefSchema,
  changedComponent: changedComponentSchema.optional(),
  agent: agentRefSchema,
  target: workTargetSchema,
  trials: z.number().int().min(1).max(20).default(1),
  visibility: visibilitySchema.default('public'),
});
export type CreateExperimentRequest = z.infer<typeof createExperimentRequestSchema>;

// ---- tournaments --------------------------------------------------------------------------------

export const tournamentFormatSchema = z.enum(['single_elimination']);
export type TournamentFormat = z.infer<typeof tournamentFormatSchema>;

export const tournamentStatusSchema = z.enum(['draft', 'open', 'running', 'completed', 'cancelled']);
export type TournamentStatus = z.infer<typeof tournamentStatusSchema>;

export const tournamentEntrantSchema = z.object({
  /** 0-based position in the entrant list; matches refer to it */
  index: z.number().int().nonnegative(),
  label: z.string().min(1).max(80),
  harness: harnessRefSchema,
  /** harness slug once the server resolved it */
  harnessSlug: z.string().nullable(),
  /** lower seeds meet later; assigned from rating at bracket time */
  seed: z.number().int().positive().nullable(),
});
export type TournamentEntrant = z.infer<typeof tournamentEntrantSchema>;

export const tournamentMatchSchema = z.object({
  id: z.string(),
  round: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
  /** entrant index; null = slot not yet determined (waits on a previous round) */
  a: z.number().int().nonnegative().nullable(),
  b: z.number().int().nonnegative().nullable(),
  /** a match with one entrant and no opponent advances that entrant */
  bye: z.boolean(),
  battleIds: z.array(z.string()),
  /** entrant index, set from the battle verdict; a tie is settled by the higher seed, and shown */
  winner: z.number().int().nonnegative().nullable(),
  settledBy: z.enum(['verdict', 'bye', 'seed', 'forfeit']).nullable(),
});
export type TournamentMatch = z.infer<typeof tournamentMatchSchema>;

export const tournamentSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).nullable(),
  format: tournamentFormatSchema,
  status: tournamentStatusSchema,
  createdBy: z.object({ id: z.string(), login: z.string() }).nullable(),
  agent: agentRefSchema,
  target: workTargetSchema,
  entrants: z.array(tournamentEntrantSchema),
  rounds: z.array(
    z.object({ index: z.number().int().nonnegative(), matches: z.array(tournamentMatchSchema) }),
  ),
  winner: z.number().int().nonnegative().nullable(),
  visibility: visibilitySchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type Tournament = z.infer<typeof tournamentSchema>;

export const createTournamentRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  format: tournamentFormatSchema.default('single_elimination'),
  agent: agentRefSchema,
  target: workTargetSchema,
  entrants: z.array(competitorRefSchema).min(2).max(64),
  visibility: visibilitySchema.default('public'),
});
export type CreateTournamentRequest = z.infer<typeof createTournamentRequestSchema>;

// ---- bounties -----------------------------------------------------------------------------------

export const bountyStatusSchema = z.enum(['open', 'closed', 'awarded', 'expired', 'cancelled']);
export type BountyStatus = z.infer<typeof bountyStatusSchema>;

/**
 * What a submission must show against the baseline on the bounty's target. Every ratio compares
 * the submission's side to the baseline's side on the same battle; 0.8 = at most 80% of baseline.
 */
export const bountyConditionSchema = z.object({
  /** the submission must be the decided winner of every battle (default) or of the majority */
  mustWin: z.enum(['every', 'majority']).default('every'),
  maxTokensRatio: z.number().positive().max(1).optional(),
  maxCostRatio: z.number().positive().max(1).optional(),
  maxDurationRatio: z.number().positive().max(1).optional(),
  /** minimum battles the submission must have run */
  minBattles: z.number().int().min(1).max(200).default(1),
});
export type BountyCondition = z.infer<typeof bountyConditionSchema>;

export const bountySchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(8000).nullable(),
  status: bountyStatusSchema,
  createdBy: z.object({ id: z.string(), login: z.string() }).nullable(),
  baseline: competitorRefSchema,
  agent: agentRefSchema,
  target: workTargetSchema,
  condition: bountyConditionSchema,
  /** reputation-only or an externally fulfilled prize; Arena moves no money */
  reward: z.object({ kind: z.enum(['reputation', 'external']), description: z.string().max(1000) }),
  eligibility: z.string().max(2000).nullable(),
  deadline: z.string().nullable(),
  submissionCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type Bounty = z.infer<typeof bountySchema>;

export const bountySubmissionSchema = z.object({
  id: z.string(),
  bountyId: z.string(),
  submittedBy: z.object({ id: z.string(), login: z.string() }).nullable(),
  harness: competitorRefSchema,
  battleIds: z.array(z.string()),
  /** deterministic evaluation of the condition over the linked battles */
  result: z
    .object({
      met: z.boolean(),
      battles: z.number().int().nonnegative(),
      reasons: z.array(z.string()),
    })
    .nullable(),
  createdAt: z.string(),
});
export type BountySubmission = z.infer<typeof bountySubmissionSchema>;

export const createBountyRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(8000).optional(),
  baseline: competitorRefSchema,
  agent: agentRefSchema,
  target: workTargetSchema,
  condition: bountyConditionSchema.prefault({}),
  reward: z.object({ kind: z.enum(['reputation', 'external']), description: z.string().max(1000) }),
  eligibility: z.string().max(2000).optional(),
  deadline: z.string().optional(),
});
export type CreateBountyRequest = z.infer<typeof createBountyRequestSchema>;

// ---- lineage ------------------------------------------------------------------------------------

export const lineageRelationSchema = z.enum([
  'forked_from',
  'derived_from',
  'based_on',
  'previous_version',
  'component_source',
]);
export type LineageRelation = z.infer<typeof lineageRelationSchema>;

/** Where the relationship claim came from. Arena never infers one. */
export const lineageEvidenceSchema = z.enum(['github_fork', 'manifest', 'declared']);
export type LineageEvidence = z.infer<typeof lineageEvidenceSchema>;

export const lineageEdgeSchema = z.object({
  /** the harness the edge belongs to (child) */
  harnessSlug: z.string(),
  relation: lineageRelationSchema,
  /** parent harness slug when it is catalogued, else null */
  parentSlug: z.string().nullable(),
  /** the parent's source URL as declared, always kept */
  parentSource: z.string(),
  evidence: lineageEvidenceSchema,
  createdAt: z.string(),
});
export type LineageEdge = z.infer<typeof lineageEdgeSchema>;

// ---- head-to-head ------------------------------------------------------------------------------

export const headToHeadFilterSchema = z.object({
  agentId: z.string().optional(),
  category: ratingCategorySchema.optional(),
  pool: ratingPoolSchema.optional(),
  benchmarkSlug: benchmarkSlugSchema.optional(),
  /** harness commit (prefix allowed) on the subject side */
  commit: z.string().max(40).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});
export type HeadToHeadFilter = z.infer<typeof headToHeadFilterSchema>;

export const headToHeadSchema = z.object({
  subject: z.object({ slug: z.string(), name: z.string() }),
  opponent: z.object({ slug: z.string(), name: z.string() }),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  /** decided battles only */
  battles: z.number().int().nonnegative(),
  winRate: z.number().min(0).max(1).nullable(),
  lastBattleAt: z.string().nullable(),
  recentBattleIds: z.array(z.string()),
  filter: headToHeadFilterSchema,
});
export type HeadToHead = z.infer<typeof headToHeadSchema>;

// ---- API responses for the competitive layer ----------------------------------------------------
//
// Appended by the challenges/tournaments/bounties/lineage/components workstream. Everything below is
// what /api/v1/{challenges,tournaments,bounties,components} and /api/v1/harnesses/:slug/lineage
// return, and every one of those payloads repeats ARENA_EXECUTION_NOTE so no client can present a
// linked battle as something Arena ran.

/** Repeated verbatim on every competitive response, in the CLI help and in the MCP tool descriptions. */
export const ARENA_EXECUTION_NOTE =
  'Arena hosts no runner. A challenge, a tournament match and a bounty submission are executed locally, ' +
  'with the arena CLI, by whoever accepts them, and the battle is uploaded afterwards. The server stores ' +
  'the definition, verifies the competitors and links the battle; every result is community-reported.';

export const challengeResponseSchema = z.object({
  challenge: challengeSchema,
  url: z.string(),
  note: z.string(),
});
export type ChallengeResponse = z.infer<typeof challengeResponseSchema>;

export const challengeListResponseSchema = z.object({
  challenges: z.array(challengeSchema),
  count: z.number().int().nonnegative(),
  note: z.string(),
});
export type ChallengeListResponse = z.infer<typeof challengeListResponseSchema>;

export const tournamentResponseSchema = z.object({
  tournament: tournamentSchema,
  url: z.string(),
  note: z.string(),
});
export type TournamentResponse = z.infer<typeof tournamentResponseSchema>;

export const tournamentListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: tournamentStatusSchema,
  format: tournamentFormatSchema,
  entrants: z.number().int().nonnegative(),
  rounds: z.number().int().nonnegative(),
  /** entrant index of the champion, once the final settles */
  winner: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
});
export type TournamentListItem = z.infer<typeof tournamentListItemSchema>;

export const tournamentListResponseSchema = z.object({
  tournaments: z.array(tournamentListItemSchema),
  count: z.number().int().nonnegative(),
  note: z.string(),
});
export type TournamentListResponse = z.infer<typeof tournamentListResponseSchema>;

export const bountyResponseSchema = z.object({
  bounty: bountySchema,
  submissions: z.array(bountySubmissionSchema),
  url: z.string(),
  note: z.string(),
});
export type BountyResponse = z.infer<typeof bountyResponseSchema>;

export const bountyListResponseSchema = z.object({
  bounties: z.array(bountySchema),
  count: z.number().int().nonnegative(),
  note: z.string(),
});
export type BountyListResponse = z.infer<typeof bountyListResponseSchema>;

/** POST /api/v1/bounties/:id/submissions — the harness that claims the bounty. */
export const createBountySubmissionRequestSchema = z.object({ harness: competitorRefSchema });
export type CreateBountySubmissionRequest = z.infer<typeof createBountySubmissionRequestSchema>;

export const bountySubmissionResponseSchema = z.object({
  submission: bountySubmissionSchema,
  url: z.string(),
  note: z.string(),
});
export type BountySubmissionResponse = z.infer<typeof bountySubmissionResponseSchema>;

export const bountySubmissionListResponseSchema = z.object({
  submissions: z.array(bountySubmissionSchema),
  count: z.number().int().nonnegative(),
  note: z.string(),
});
export type BountySubmissionListResponse = z.infer<typeof bountySubmissionListResponseSchema>;

export const lineageResponseSchema = z.object({
  harnessSlug: z.string(),
  /** edges this harness declares about its own parents */
  ancestors: z.array(lineageEdgeSchema),
  /** edges other harnesses declare that name this one as the parent */
  descendants: z.array(lineageEdgeSchema),
  /** how a reader should weigh each evidence value */
  evidenceNote: z.string(),
});
export type LineageResponse = z.infer<typeof lineageResponseSchema>;

export const LINEAGE_EVIDENCE_NOTE =
  'Arena never infers ancestry. `github_fork` comes from GitHub fork metadata read at import, ' +
  '`manifest` from the harness own arena.yaml `lineage:` block, `declared` from a person saying so.';

/** What experiments say about a component. Null averages with n = 0 mean "nobody has measured it". */
export const componentEvidenceSchema = z.object({
  /** experiments naming this component as the one thing that changed */
  experiments: z.number().int().nonnegative(),
  /** of those, the completed ones that carry a summary: the n behind the averages */
  summarized: z.number().int().nonnegative(),
  /** mean correctness delta in percentage points, treatment minus control */
  correctnessDeltaPoints: z.number().nullable(),
  /** mean token change in percent, treatment against control */
  tokenDeltaPercent: z.number().nullable(),
});
export type ComponentEvidence = z.infer<typeof componentEvidenceSchema>;

export const componentSummarySchema = z.object({
  slug: z.string(),
  kind: componentKindSchema,
  name: z.string(),
  description: z.string().nullable(),
  source: z.string().nullable(),
  /** harnesses whose arena.yaml declares it */
  harnesses: z.number().int().nonnegative(),
  evidence: componentEvidenceSchema,
  createdAt: z.string(),
});
export type ComponentSummary = z.infer<typeof componentSummarySchema>;

export const componentDetailSchema = componentSummarySchema.extend({
  harnessList: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      commit: z.string().nullable(),
      path: z.string().nullable(),
    }),
  ),
  experimentList: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      kind: experimentKindSchema,
      status: experimentStatusSchema,
      battles: z.number().int().nonnegative(),
      correctnessDeltaPoints: z.number().nullable(),
      tokenDeltaPercent: z.number().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type ComponentDetail = z.infer<typeof componentDetailSchema>;

export const componentListResponseSchema = z.object({
  components: z.array(componentSummarySchema),
  count: z.number().int().nonnegative(),
});
export type ComponentListResponse = z.infer<typeof componentListResponseSchema>;

export const componentDetailResponseSchema = z.object({ component: componentDetailSchema });
export type ComponentDetailResponse = z.infer<typeof componentDetailResponseSchema>;
