import { index, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import type { HarnessInspection, HarnessManifest, ResolvedTask } from '@harness-arena/protocol';
import { harnessFrameworkEnum, harnessSourceKindEnum, repositoryKindEnum, taskKindEnum } from './enums.js';
import { users } from './identity.js';

/** The agent CLIs Arena can drive. The id is the protocol agent id, e.g. `claude-code`. */
export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  vendor: text('vendor').notNull(),
  homepage: text('homepage'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A harness: a repository (or `vanilla`) whose configuration files are laid into a battle workspace. */
export const harnesses = pgTable(
  'harnesses',
  {
    /** `hrn_` + 16 base36 chars */
    id: text('id').primaryKey(),
    /** `owner--repo` for GitHub, otherwise a slugified local/git name; stable across battles */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    sourceKind: harnessSourceKindEnum('source_kind').notNull(),
    sourceUrl: text('source_url'),
    /** set when a signed-in user imported the harness; null for harnesses discovered from battles */
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    description: text('description'),
    framework: harnessFrameworkEnum('framework').notNull().default('unknown'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('harnesses_owner_idx').on(t.ownerUserId)],
);

/** One commit of a harness. `commit` is null for `vanilla` and for local harnesses outside git. */
export const harnessVersions = pgTable(
  'harness_versions',
  {
    /** `hvr_` + 16 base36 chars */
    id: text('id').primaryKey(),
    harnessId: text('harness_id')
      .notNull()
      .references(() => harnesses.id, { onDelete: 'cascade' }),
    commit: text('commit'),
    manifest: jsonb('manifest').$type<HarnessManifest>(),
    inspection: jsonb('inspection').$type<HarnessInspection>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('harness_versions_commit_uq').on(t.harnessId, t.commit).nullsNotDistinct()],
);

/** Repositories battles ran against, keyed by the source string the user supplied. */
export const repositories = pgTable('repositories', {
  /** `rep_` + 16 base36 chars */
  id: text('id').primaryKey(),
  source: text('source').notNull().unique(),
  kind: repositoryKindEnum('kind').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A resolved task. The id is derived from the task content, so identical tasks are shared. */
export const tasks = pgTable('tasks', {
  /** `tsk_` + 24 hex chars of sha256(kind|title|prompt|source) */
  id: text('id').primaryKey(),
  kind: taskKindEnum('kind').notNull(),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  source: jsonb('source').$type<ResolvedTask['source']>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
