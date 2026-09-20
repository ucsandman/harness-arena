import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import type {
  AgentRef,
  BenchmarkPack,
  BountyCondition,
  BountySubmission,
  ChangedComponent,
  CompetitorRef,
  ExperimentSummary,
  PrivacySettings,
  TournamentEntrant,
  WorkTarget,
} from '@harness-arena/protocol';
import {
  bountyStatusEnum,
  challengeStatusEnum,
  componentKindEnum,
  experimentKindEnum,
  experimentStatusEnum,
  lineageEvidenceEnum,
  lineageRelationEnum,
  tournamentFormatEnum,
  tournamentStatusEnum,
  visibilityEnum,
} from './enums.js';
import { harnessVersions, harnesses } from './catalog.js';
import { battles } from './battles.js';
import { users } from './identity.js';

/**
 * The competitive layer. Every table here stores a DEFINITION plus links to battles; nothing here
 * executes anything. Battles are still produced by the CLI on a contributor's machine and uploaded,
 * so every result linked from these tables is a community result.
 */

// ---- benchmark packs ------------------------------------------------------------------------------

/** A pack's identity across versions. The slug is global; the first publisher owns it. */
export const benchmarks = pgTable(
  'benchmarks',
  {
    /** `bmk_` + 16 base36 chars */
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    author: text('author'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    visibility: visibilityEnum('visibility').notNull().default('public'),
    /** the version shown by default: the most recently published one */
    latestVersionId: text('latest_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('benchmarks_owner_idx').on(t.ownerUserId)],
);

/**
 * One immutable pack version. The id is `bmv_` + sha256 of the canonical pack content, so the same
 * content always maps to the same row and a ranked result can never point at edited tasks.
 */
export const benchmarkVersions = pgTable(
  'benchmark_versions',
  {
    id: text('id').primaryKey(),
    benchmarkId: text('benchmark_id')
      .notNull()
      .references(() => benchmarks.id, { onDelete: 'cascade' }),
    /** the pack's human version label */
    version: text('version').notNull(),
    pack: jsonb('pack').$type<BenchmarkPack>().notNull(),
    taskCount: integer('task_count').notNull(),
    battlesPerRun: integer('battles_per_run').notNull(),
    categories: jsonb('categories').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('benchmark_versions_label_uq').on(t.benchmarkId, t.version),
    index('benchmark_versions_benchmark_idx').on(t.benchmarkId),
  ],
);

/** Projection of a version's tasks for filtering and category leaderboards. */
export const benchmarkTasks = pgTable(
  'benchmark_tasks',
  {
    versionId: text('version_id')
      .notNull()
      .references(() => benchmarkVersions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull(),
    repositorySource: text('repository_source').notNull(),
    repositoryCommit: text('repository_commit'),
    trials: integer('trials').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.taskId] }),
    index('benchmark_tasks_category_idx').on(t.category),
  ],
);

// ---- challenges -----------------------------------------------------------------------------------

export const challenges = pgTable(
  'challenges',
  {
    /** `chl_` + 16 base36 chars */
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    status: challengeStatusEnum('status').notNull().default('open'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    acceptedByUserId: text('accepted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    sideA: jsonb('side_a').$type<CompetitorRef>().notNull(),
    sideB: jsonb('side_b').$type<CompetitorRef>().notNull(),
    /** catalogue rows once resolved; null until a battle names them */
    harnessAId: text('harness_a_id').references(() => harnesses.id, { onDelete: 'set null' }),
    harnessBId: text('harness_b_id').references(() => harnesses.id, { onDelete: 'set null' }),
    agent: jsonb('agent').$type<AgentRef>().notNull(),
    target: jsonb('target').$type<WorkTarget>().notNull(),
    benchmarkVersionId: text('benchmark_version_id').references(() => benchmarkVersions.id, {
      onDelete: 'set null',
    }),
    privacy: jsonb('privacy').$type<PrivacySettings>().notNull(),
    visibility: visibilityEnum('visibility').notNull().default('public'),
    ratingEligible: boolean('rating_eligible').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('challenges_status_created_idx').on(t.status, t.createdAt),
    index('challenges_harness_a_idx').on(t.harnessAId),
    index('challenges_harness_b_idx').on(t.harnessBId),
  ],
);

// ---- experiments ----------------------------------------------------------------------------------

export const experiments = pgTable(
  'experiments',
  {
    /** `exp_` + 16 base36 chars */
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    kind: experimentKindEnum('kind').notNull(),
    status: experimentStatusEnum('status').notNull().default('planned'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    control: jsonb('control').$type<CompetitorRef>().notNull(),
    treatment: jsonb('treatment').$type<CompetitorRef>().notNull(),
    /** the harness both sides belong to for regression/ablation; null for a comparison */
    harnessId: text('harness_id').references(() => harnesses.id, { onDelete: 'set null' }),
    controlVersionId: text('control_version_id').references(() => harnessVersions.id, {
      onDelete: 'set null',
    }),
    treatmentVersionId: text('treatment_version_id').references(() => harnessVersions.id, {
      onDelete: 'set null',
    }),
    changedComponent: jsonb('changed_component').$type<ChangedComponent>(),
    componentId: text('component_id'),
    agent: jsonb('agent').$type<AgentRef>().notNull(),
    target: jsonb('target').$type<WorkTarget>().notNull(),
    benchmarkVersionId: text('benchmark_version_id').references(() => benchmarkVersions.id, {
      onDelete: 'set null',
    }),
    trials: integer('trials').notNull().default(1),
    visibility: visibilityEnum('visibility').notNull().default('public'),
    summary: jsonb('summary').$type<ExperimentSummary>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('experiments_harness_idx').on(t.harnessId),
    index('experiments_status_created_idx').on(t.status, t.createdAt),
    index('experiments_component_idx').on(t.componentId),
  ],
);

// ---- tournaments ----------------------------------------------------------------------------------

export const tournaments = pgTable(
  'tournaments',
  {
    /** `trn_` + 16 base36 chars */
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    format: tournamentFormatEnum('format').notNull().default('single_elimination'),
    status: tournamentStatusEnum('status').notNull().default('draft'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    agent: jsonb('agent').$type<AgentRef>().notNull(),
    target: jsonb('target').$type<WorkTarget>().notNull(),
    benchmarkVersionId: text('benchmark_version_id').references(() => benchmarkVersions.id, {
      onDelete: 'set null',
    }),
    entrants: jsonb('entrants').$type<TournamentEntrant[]>().notNull(),
    /** entrant index */
    winner: integer('winner'),
    visibility: visibilityEnum('visibility').notNull().default('public'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tournaments_status_created_idx').on(t.status, t.createdAt)],
);

export const tournamentMatches = pgTable(
  'tournament_matches',
  {
    /** `tmt_` + 16 base36 chars */
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    position: integer('position').notNull(),
    /** entrant indexes; null until the feeding match settles */
    entrantA: integer('entrant_a'),
    entrantB: integer('entrant_b'),
    bye: boolean('bye').notNull().default(false),
    winner: integer('winner'),
    settledBy: text('settled_by').$type<'verdict' | 'bye' | 'seed' | 'forfeit'>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tournament_matches_slot_uq').on(t.tournamentId, t.round, t.position),
    index('tournament_matches_tournament_idx').on(t.tournamentId),
  ],
);

// ---- bounties -------------------------------------------------------------------------------------

export const bounties = pgTable(
  'bounties',
  {
    /** `bty_` + 16 base36 chars */
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    status: bountyStatusEnum('status').notNull().default('open'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    baseline: jsonb('baseline').$type<CompetitorRef>().notNull(),
    baselineHarnessId: text('baseline_harness_id').references(() => harnesses.id, { onDelete: 'set null' }),
    agent: jsonb('agent').$type<AgentRef>().notNull(),
    target: jsonb('target').$type<WorkTarget>().notNull(),
    benchmarkVersionId: text('benchmark_version_id').references(() => benchmarkVersions.id, {
      onDelete: 'set null',
    }),
    condition: jsonb('condition').$type<BountyCondition>().notNull(),
    rewardKind: text('reward_kind').$type<'reputation' | 'external'>().notNull(),
    rewardDescription: text('reward_description').notNull(),
    eligibility: text('eligibility'),
    deadline: timestamp('deadline', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bounties_status_created_idx').on(t.status, t.createdAt)],
);

export const bountySubmissions = pgTable(
  'bounty_submissions',
  {
    /** `bsb_` + 16 base36 chars */
    id: text('id').primaryKey(),
    bountyId: text('bounty_id')
      .notNull()
      .references(() => bounties.id, { onDelete: 'cascade' }),
    submittedByUserId: text('submitted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    harness: jsonb('harness').$type<CompetitorRef>().notNull(),
    harnessId: text('harness_id').references(() => harnesses.id, { onDelete: 'set null' }),
    result: jsonb('result').$type<BountySubmission['result']>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bounty_submissions_bounty_idx').on(t.bountyId)],
);

// ---- links from battles to arena objects ------------------------------------------------------------

/**
 * One row per (battle, arena object). A battle can serve one challenge, one experiment, one tournament
 * match and one bounty submission at most; the CLI sets the ids in `spec.arena` and the server verifies
 * the battle's competitors match the object before linking.
 */
export const battleLinks = pgTable(
  'battle_links',
  {
    battleId: text('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .$type<'challenge' | 'experiment' | 'tournament_match' | 'bounty_submission'>()
      .notNull(),
    targetId: text('target_id').notNull(),
    /** for an experiment: which side of the battle was the treatment */
    treatmentSide: text('treatment_side').$type<'a' | 'b'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.battleId, t.kind] }),
    index('battle_links_target_idx').on(t.kind, t.targetId),
  ],
);

// ---- lineage --------------------------------------------------------------------------------------

export const harnessLineage = pgTable(
  'harness_lineage',
  {
    /** `lin_` + 16 base36 chars */
    id: text('id').primaryKey(),
    harnessId: text('harness_id')
      .notNull()
      .references(() => harnesses.id, { onDelete: 'cascade' }),
    relation: lineageRelationEnum('relation').notNull(),
    parentHarnessId: text('parent_harness_id').references(() => harnesses.id, { onDelete: 'set null' }),
    parentSource: text('parent_source').notNull(),
    evidence: lineageEvidenceEnum('evidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('harness_lineage_uq').on(t.harnessId, t.relation, t.parentSource),
    index('harness_lineage_parent_idx').on(t.parentHarnessId),
  ],
);

// ---- components -----------------------------------------------------------------------------------

/** A reusable part of a harness (skill, hook, MCP config, ...) that experiments can carry evidence for. */
export const components = pgTable(
  'components',
  {
    /** `cmp_` + 16 base36 chars */
    id: text('id').primaryKey(),
    kind: componentKindEnum('kind').notNull(),
    /** `<kind>/<name>` lowercased; the catalogue key */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    /** where it lives, when known: a repository URL or a path inside one */
    source: text('source'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('components_kind_idx').on(t.kind)],
);

/** Which harness versions declare which components (from arena.yaml `components`). */
export const harnessComponents = pgTable(
  'harness_components',
  {
    harnessVersionId: text('harness_version_id')
      .notNull()
      .references(() => harnessVersions.id, { onDelete: 'cascade' }),
    componentId: text('component_id')
      .notNull()
      .references(() => components.id, { onDelete: 'cascade' }),
    path: text('path'),
  },
  (t) => [primaryKey({ columns: [t.harnessVersionId, t.componentId] })],
);
