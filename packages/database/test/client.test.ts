import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ArenaDb } from '../src/client.js';
import {
  availableMigrations,
  countAppliedMigrations,
  createDb,
  extractRows,
  resolveMigrationsFolder,
} from '../src/client.js';
import { freshDb } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tableNames(handle: ArenaDb): Promise<string[]> {
  const result = await handle.db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  );
  return extractRows(result).map((row) => String((row as { table_name: string }).table_name));
}

describe('createDb', () => {
  it('migrates an in-memory PGlite database cleanly and records every migration', async () => {
    const handle = await freshDb();
    cleanups.push(() => handle.close());

    expect(handle.kind).toBe('pglite');
    expect(availableMigrations()).toBeGreaterThan(0);
    expect(await countAppliedMigrations(handle.db)).toBe(availableMigrations());

    const tables = await tableNames(handle);
    expect(tables).toEqual(
      expect.arrayContaining([
        'agents',
        'artifacts',
        'battle_runs',
        'battles',
        'device_codes',
        'devices',
        'evaluations',
        'events',
        'harness_versions',
        'harnesses',
        'metrics',
        'rating_events',
        'ratings',
        'repositories',
        'sessions',
        'tasks',
        'users',
        // 0001_arena
        'battle_links',
        'benchmark_tasks',
        'benchmark_versions',
        'benchmarks',
        'bounties',
        'bounty_submissions',
        'challenges',
        'components',
        'experiments',
        'harness_components',
        'harness_lineage',
        'tournament_matches',
        'tournaments',
      ]),
    );
    expect(tables).toHaveLength(30);
  });

  it('is idempotent: migrating twice applies nothing the second time', async () => {
    const handle = await freshDb();
    cleanups.push(() => handle.close());
    const before = await countAppliedMigrations(handle.db);
    await handle.migrate();
    expect(await countAppliedMigrations(handle.db)).toBe(before);
  });

  it('persists to a data directory and reopens it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arena-db-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const first = await createDb({ dataDir: path.join(dir, 'store') });
    await first.migrate();
    await first.db.execute(
      sql`insert into agents (id, display_name, vendor) values ('probe', 'Probe', 'test')`,
    );
    await first.close();

    const second = await createDb({ dataDir: path.join(dir, 'store') });
    cleanups.push(() => second.close());
    const rows = extractRows(await second.db.execute(sql`select id from agents where id = 'probe'`));
    expect(rows).toHaveLength(1);
  });

  it('rejects a url that is neither postgres nor pglite', async () => {
    await expect(createDb({ url: 'mysql://localhost/arena' })).rejects.toThrow(/unsupported database url/);
  });

  it('resolves the migrations folder from the package', () => {
    const folder = resolveMigrationsFolder();
    expect(path.basename(folder)).toBe('drizzle');
  });
});
