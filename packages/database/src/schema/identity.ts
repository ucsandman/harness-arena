import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { deviceCodeStatusEnum, userPlanEnum } from './enums.js';

/** GitHub OAuth accounts. Provider (model) credentials are never stored; only the GitHub identity. */
export const users = pgTable(
  'users',
  {
    /** `usr_` + 16 base36 chars */
    id: text('id').primaryKey(),
    githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
    login: text('login').notNull(),
    name: text('name'),
    avatarUrl: text('avatar_url'),
    email: text('email'),
    plan: userPlanEnum('plan').notNull().default('free'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_login_idx').on(t.login)],
);

/** Browser sessions. The id is the sha256 of the cookie token, so the token itself is never stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** RFC 8628-style device login: the CLI shows `userCode`, the browser approves it. */
export const deviceCodes = pgTable(
  'device_codes',
  {
    id: text('id').primaryKey(),
    /** sha256 of the long device code held by the CLI */
    deviceCodeHash: text('device_code_hash').notNull().unique(),
    /** 8 display characters, e.g. ABCD-1234 */
    userCode: text('user_code').notNull().unique(),
    deviceName: text('device_name').notNull(),
    status: deviceCodeStatusEnum('status').notNull().default('pending'),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (t) => [index('device_codes_status_idx').on(t.status, t.expiresAt)],
);

/** Revocable CLI tokens. Stored hashed; `tokenPrefix` exists only so the UI can identify a token. */
export const devices = pgTable(
  'devices',
  {
    /** `dev_` + 16 base36 chars */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** sha256 of the bearer token */
    tokenHash: text('token_hash').notNull().unique(),
    /** first 8 characters of the token, for display only */
    tokenPrefix: text('token_prefix').notNull(),
    scopes: text('scopes').array().notNull().default(['battles:write']),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);
