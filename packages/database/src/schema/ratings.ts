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
import { agents, harnesses } from './catalog.js';
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('rating_events_unique').on(t.battleId, t.harnessId, t.agentId, t.category, t.pool),
    index('rating_events_battle_idx').on(t.battleId),
  ],
);
