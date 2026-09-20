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
export * from './benchmarks.js';
export * from './experiments.js';
export * from './challenges.js';
export * from './tournaments.js';
export * from './bounties.js';
export * from './lineage.js';
export * from './components.js';
export * from './links.js';
export * from './headtohead.js';
export * from './insights.js';
