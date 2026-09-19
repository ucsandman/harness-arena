import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.js';

/**
 * Two drivers, one type. Both `drizzle-orm/postgres-js` and `drizzle-orm/pglite` return a
 * `PgDatabase`, so every query helper takes this type and works against Postgres, PGlite and a
 * transaction handle (`PgTransaction` extends `PgDatabase`).
 */
export type ArenaDatabase = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type DbKind = 'postgres' | 'pglite';

/** Minimal logger so the package never depends on a logging implementation. */
export interface DbLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface ArenaDb {
  db: ArenaDatabase;
  kind: DbKind;
  close(): Promise<void>;
  migrate(): Promise<void>;
}

export interface CreateDbOptions {
  /** postgres:// or postgresql:// for a server; pglite:// or empty for the embedded database */
  url?: string;
  /** PGlite data directory; `pglite://memory` (or a url of `pglite://memory`) means in-memory */
  dataDir?: string;
  logger?: DbLogger;
}

export const DEFAULT_PGLITE_DIR = path.join('.data', 'arena-pglite');
export const IN_MEMORY_URL = 'pglite://memory';

const PGLITE_MEMORY_DATA_DIR = 'memory://';

function isPostgresUrl(url: string): boolean {
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

/** `pglite://memory` -> in-memory, `pglite:///abs/path` or `pglite://./rel` -> that directory. */
function pgliteDataDirFromUrl(url: string, fallback: string): string {
  if (!url) return fallback;
  const rest = url.slice('pglite://'.length);
  if (rest === '' || rest === 'memory' || rest === 'memory://') return PGLITE_MEMORY_DATA_DIR;
  return rest;
}

/**
 * Where the generated SQL lives. Must resolve from `src/` (vitest, tsx) and from `dist/`, and the
 * build copies `drizzle/` next to the compiled output as well.
 */
export function resolveMigrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'drizzle'),
    path.join(here, '..', 'drizzle'),
    path.join(here, '..', '..', 'drizzle'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'meta', '_journal.json'))) return dir;
  }
  throw new Error(
    `no drizzle migrations found; looked in: ${candidates.join(', ')} (run "pnpm db:generate" first)`,
  );
}

/** How many migrations exist on disk. */
export function availableMigrations(folder = resolveMigrationsFolder()): number {
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: unknown[] };
  return journal.entries?.length ?? 0;
}

/** How many migrations the database has recorded as applied (0 when the table does not exist yet). */
export async function countAppliedMigrations(db: ArenaDatabase): Promise<number> {
  try {
    const result = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const rows = extractRows(result);
    const first = rows[0] as { n?: number | string } | undefined;
    return first ? Number(first.n ?? 0) : 0;
  } catch {
    return 0;
  }
}

/** postgres-js returns an array of rows, PGlite returns `{ rows }`. */
export function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

/**
 * Open a database. Never logs the connection url (it carries credentials) or the data directory
 * contents; only the driver kind and whether the store is persisted.
 */
export async function createDb(opts: CreateDbOptions = {}): Promise<ArenaDb> {
  const url = (opts.url ?? '').trim();
  const logger = opts.logger;

  if (url && isPostgresUrl(url)) {
    const [{ default: postgres }, { drizzle }, { migrate }] = await Promise.all([
      import('postgres'),
      import('drizzle-orm/postgres-js'),
      import('drizzle-orm/postgres-js/migrator'),
    ]);
    // prepare:false keeps the client compatible with transaction-pooling proxies (Neon, pgBouncer).
    const client = postgres(url, { max: 5, prepare: false });
    const db = drizzle(client, { schema });
    logger?.info('database connected', { kind: 'postgres', persisted: true });
    return {
      db: db as ArenaDatabase,
      kind: 'postgres',
      close: async () => {
        await client.end({ timeout: 5 });
      },
      migrate: async () => {
        await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
      },
    };
  }

  if (url && !url.startsWith('pglite://')) {
    throw new Error(
      `unsupported database url: expected postgres://, postgresql:// or pglite:// (got "${url.slice(0, 12)}...")`,
    );
  }

  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ]);
  const requestedDir = opts.dataDir?.trim() ?? '';
  const dataDir =
    requestedDir === IN_MEMORY_URL || requestedDir === 'memory' || requestedDir === PGLITE_MEMORY_DATA_DIR
      ? PGLITE_MEMORY_DATA_DIR
      : url
        ? pgliteDataDirFromUrl(url, requestedDir || DEFAULT_PGLITE_DIR)
        : requestedDir || DEFAULT_PGLITE_DIR;
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzle(client, { schema });
  logger?.info('database ready', { kind: 'pglite', persisted: dataDir !== PGLITE_MEMORY_DATA_DIR });
  return {
    db: db as ArenaDatabase,
    kind: 'pglite',
    close: async () => {
      await client.close();
    },
    migrate: async () => {
      await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
    },
  };
}

// One slot per process, not per module instance: Next transpiles this package into every route
// bundle, and a module-level variable would open PGlite twice and split the writes between handles.
const CACHE_KEY = Symbol.for('harness-arena.database.handle');
interface CacheSlot {
  cached: Promise<ArenaDb> | null;
}
const globalSlots = globalThis as unknown as Record<symbol, CacheSlot | undefined>;
const slot: CacheSlot = (globalSlots[CACHE_KEY] ??= { cached: null });

/**
 * Process-wide database for the web app: reads DATABASE_URL and ARENA_DATA_DIR, migrates once.
 * Values of those variables are never logged.
 */
export function getDb(logger?: DbLogger): Promise<ArenaDb> {
  slot.cached ??= createDb({
    url: process.env.DATABASE_URL,
    dataDir: process.env.ARENA_DATA_DIR,
    logger,
  }).then(async (handle) => {
    await handle.migrate();
    return handle;
  });
  return slot.cached;
}

/** Drop the memoized handle (tests, and after a close in a long-lived process). */
export async function closeDb(): Promise<void> {
  const current = slot.cached;
  slot.cached = null;
  if (current) {
    const handle = await current;
    await handle.close();
  }
}
