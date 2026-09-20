import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { ratingCategoryEnum, ratingPoolEnum } from './enums.js';
import { agents, harnessVersions, harnesses } from './catalog.js';
import { battles } from './battles.js';

/**
 * One rating per (harness, agent, category, pool). The community pool holds self-reported local
 * battles; verified is reserved for battles Arena executed itself. They are never mixed.
 */
export const ratings = pgTable(
  'ratings',
  {
    harnessId: text('harness_id')
      .notNull()
      .references(() => harnesses.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    category: ratingCategoryEnum('category').notNull(),
    pool: ratingPoolEnum('pool').notNull(),
    rating: real('rating').notNull(),
    deviation: real('deviation').notNull(),
    battles: integer('battles').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    losses: integer('losses').notNull().default(0),
    ties: integer('ties').notNull().default(0),
    provisional: boolean('provisional').notNull().default(true),
    peakRating: real('peak_rating').notNull().default(1500),
    /** last RATING_FORM_WINDOW outcomes, oldest first, as W/L/T characters */
    form: text('form').notNull().default(''),
    lastBattleAt: timestamp('last_battle_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.harnessId, t.agentId, t.category, t.pool] }),
    index('ratings_board_idx').on(t.category, t.pool, t.rating),
  ],
);

/** Audit trail of every rating change. Also the idempotency key for applying a battle. */
export const ratingEvents = pgTable(
  'rating_events',
  {
    id: text('id').primaryKey(),
    battleId: text('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    harnessId: text('harness_id')
      .notNull()
      .references(() => harnesses.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    category: ratingCategoryEnum('category').notNull(),
    pool: ratingPoolEnum('pool').notNull(),
    ratingBefore: real('rating_before').notNull(),
    ratingAfter: real('rating_after').notNull(),
    deviationBefore: real('deviation_before').notNull().default(350),
    deviationAfter: real('deviation_after').notNull().default(350),
    /** the exact harness commit that earned this change */
    harnessVersionId: text('harness_version_id').references(() => harnessVersions.id, {
      onDelete: 'set null',
    }),
    opponentHarnessId: text('opponent_harness_id').references(() => harnesses.id, { onDelete: 'set null' }),
    opponentRating: real('opponent_rating').notNull().default(1500),
    outcome: text('outcome').$type<'win' | 'loss' | 'tie'>().notNull().default('tie'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('rating_events_unique').on(t.battleId, t.harnessId, t.agentId, t.category, t.pool),
    index('rating_events_battle_idx').on(t.battleId),
    index('rating_events_history_idx').on(t.harnessId, t.agentId, t.category, t.pool, t.createdAt),
  ],
);
