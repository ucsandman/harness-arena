import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import type {
  ArenaEvent,
  BattleRecord,
  BattleSpec,
  EvaluationReport,
  EventType,
  IntegrityReport,
  MetricKey,
  MetricValue,
  RunMetrics,
  RunRecord,
  Verdict,
} from '@harness-arena/protocol';
import {
  artifactKindEnum,
  battleStatusEnum,
  battleWinnerEnum,
  eventConfidenceEnum,
  executionModeEnum,
  metricStatusEnum,
  runStatusEnum,
  sideEnum,
  verificationKindEnum,
  visibilityEnum,
} from './enums.js';
import { agents, harnesses, harnessVersions, repositories, tasks } from './catalog.js';
import { devices, users } from './identity.js';

/**
 * A battle. The `record` column holds the full BattleRecord and is authoritative: every other
 * column is a projection of it kept for indexing, filtering and cheap list queries.
 */
export const battles = pgTable(
  'battles',
  {
    /** btl_ + base36; supplied by the client and validated against battleIdSchema before insert */
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    status: battleStatusEnum('status').notNull(),
    visibility: visibilityEnum('visibility').notNull().default('private'),
    mode: executionModeEnum('mode').notNull(),
    verificationKind: verificationKindEnum('verification_kind').notNull(),
    verificationEligible: boolean('verification_eligible').notNull().default(false),
    demo: boolean('demo').notNull().default(false),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    repositoryId: text('repository_id').references(() => repositories.id),
    repositoryCommit: text('repository_commit'),
    spec: jsonb('spec').$type<BattleSpec>().notNull(),
    record: jsonb('record').$type<BattleRecord>().notNull(),
    winner: battleWinnerEnum('winner'),
    confidence: real('confidence'),
    /** free-form category hint from the spec; ratings map it onto a RatingCategory */
    category: text('category'),
    /** benchmark provenance, when the battle ran a pack task */
    benchmarkVersionId: text('benchmark_version_id'),
    benchmarkTaskId: text('benchmark_task_id'),
    benchmarkTrial: integer('benchmark_trial'),
    /** integrity checks as recomputed by this server on upload; null until evaluated */
    integrity: jsonb('integrity').$type<IntegrityReport>(),
    /** projection of integrity.eligible: may this battle move a rating */
    ratingEligible: boolean('rating_eligible').notNull().default(false),
    /** sha256 fingerprint of the matchup (task, commits, agents, harness versions, evaluation) */
    fingerprint: text('fingerprint'),
    eventCount: integer('event_count').notNull().default(0),
    eventsCapped: boolean('events_capped').notNull().default(false),
    arenaVersion: text('arena_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('battles_owner_created_idx').on(t.ownerUserId, t.createdAt),
    index('battles_visibility_created_idx').on(t.visibility, t.createdAt),
    index('battles_status_idx').on(t.status),
    index('battles_benchmark_idx').on(t.benchmarkVersionId, t.benchmarkTaskId),
    index('battles_fingerprint_idx').on(t.fingerprint),
  ],
);

/** One side of a battle. */
export const battleRuns = pgTable(
  'battle_runs',
  {
    /** run_ + base36, taken from the record */
    id: text('id').primaryKey(),
    battleId: text('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    side: sideEnum('side').notNull(),
    label: text('label').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    harnessId: text('harness_id').references(() => harnesses.id, { onDelete: 'set null' }),
    harnessVersionId: text('harness_version_id').references(() => harnessVersions.id, {
      onDelete: 'set null',
    }),
    status: runStatusEnum('status').notNull(),
    model: text('model'),
    durationMs: integer('duration_ms'),
    exitCode: integer('exit_code'),
    metrics: jsonb('metrics').$type<RunMetrics>().notNull(),
    invocation: jsonb('invocation').$type<RunRecord['invocation']>(),
    error: jsonb('error').$type<RunRecord['error']>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    unique('battle_runs_side_uq').on(t.battleId, t.side),
    index('battle_runs_battle_idx').on(t.battleId),
  ],
);

/** The event log. (battle_id, seq) is the primary key, so re-uploading a batch is a no-op. */
export const events = pgTable(
  'events',
  {
    battleId: text('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    /** evt_ + base36, from the event envelope */
    id: text('id').notNull(),
    runId: text('run_id'),
    side: sideEnum('side'),
    type: text('type').$type<EventType>().notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    tOffsetMs: integer('t_offset_ms').notNull(),
    source: jsonb('source').$type<ArenaEvent['source']>().notNull(),
    confidence: eventConfidenceEnum('confidence').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.battleId, t.seq] }),
    index('events_battle_type_idx').on(t.battleId, t.type),
  ],
);

/** Denormalized metric table, filled from the record. Makes cross-battle comparisons cheap. */
export const metrics = pgTable(
  'metrics',
  {
    battleId: text('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    side: sideEnum('side').notNull(),
    key: text('key').$type<MetricKey>().notNull(),
    value: jsonb('value').$type<MetricValue['value']>(),
    status: metricStatusEnum('status').notNull(),
  },
  (t) => [primaryKey({ columns: [t.battleId, t.side, t.key] })],
);

/** The evaluation report and verdict, extracted from the record so they can be queried. */
export const evaluations = pgTable(
  'evaluations',
  {
    /** evl_ + base36 */
    id: text('id').primaryKey(),
    battleId: text('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    report: jsonb('report').$type<EvaluationReport>(),
    verdict: jsonb('verdict').$type<Verdict>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('evaluations_battle_idx').on(t.battleId)],
);

/** Large text blobs kept out of the record: diffs, final responses, rendered reports. */
export const artifacts = pgTable(
  'artifacts',
  {
    /** art_ + base36 */
    id: text('id').primaryKey(),
    battleId: text('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    /** null for battle-level artifacts such as the rendered report */
    side: sideEnum('side'),
    kind: artifactKindEnum('kind').notNull(),
    content: text('content').notNull(),
    contentType: text('content_type').notNull().default('text/plain'),
    bytes: integer('bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('artifacts_battle_side_kind_uq').on(t.battleId, t.side, t.kind).nullsNotDistinct()],
);
