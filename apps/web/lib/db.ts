import { createDb, type ArenaDatabase, type ArenaDb } from '@harness-arena/database';

/**
 * One database handle for the whole server process.
 *
 * `getDb()` memoizes in a module variable, which is not enough here: Next bundles route handlers and
 * pages separately and `@harness-arena/database` is transpiled into each bundle, so a module-level
 * cache can exist more than once in one process. With Postgres that only wastes a pool; with the
 * embedded PGlite store it is a correctness bug, because a second handle on the same data directory
 * does not see the first handle's writes (a session created by a route handler was invisible to a
 * page). Keying the promise on a global symbol gives every bundle the same handle.
 *
 * Reads DATABASE_URL and ARENA_DATA_DIR, migrates once, and never logs either value.
 */
const HANDLE = Symbol.for('harness-arena.web.database');

type GlobalWithDb = typeof globalThis & { [HANDLE]?: Promise<ArenaDb> };

function handle(): Promise<ArenaDb> {
  const store = globalThis as GlobalWithDb;
  store[HANDLE] ??= createDb({ url: process.env.DATABASE_URL, dataDir: process.env.ARENA_DATA_DIR }).then(
    async (opened) => {
      await opened.migrate();
      return opened;
    },
  );
  return store[HANDLE];
}

export async function db(): Promise<ArenaDatabase> {
  return (await handle()).db;
}

/** Closes the process-wide handle and forgets it. Tests and shutdown hooks only. */
export async function closeWebDb(): Promise<void> {
  const store = globalThis as GlobalWithDb;
  const current = store[HANDLE];
  delete store[HANDLE];
  if (current) await (await current).close();
}
