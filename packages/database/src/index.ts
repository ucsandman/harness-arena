/**
 * @harness-arena/database — Drizzle schema, migrations and queries.
 *
 * Postgres in production (DATABASE_URL), embedded PGlite for dev and tests (zero setup).
 * The BattleRecord stored in `battles.record` is authoritative; every other column and table is a
 * projection of it, so a re-upload of the same record converges instead of duplicating.
 */
export * as schema from './schema/index.js';
export * from './schema/index.js';
export * from './client.js';
export * from './ratings.js';
export * from './queries.js';
export * from './derive.js';
export * from './seed.js';
