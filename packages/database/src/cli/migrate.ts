/**
 * Apply pending migrations. Run with `pnpm db:migrate` (tsx).
 *
 * Reads DATABASE_URL (Postgres) or falls back to the embedded PGlite store in ARENA_DATA_DIR.
 * Values of those variables are never printed.
 */
import { availableMigrations, countAppliedMigrations, createDb } from '../client.js';

const logger = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[arena:db] ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[arena:db] ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`),
};

async function main(): Promise<void> {
  const handle = await createDb({
    url: process.env.DATABASE_URL,
    dataDir: process.env.ARENA_DATA_DIR,
    logger,
  });
  try {
    const before = await countAppliedMigrations(handle.db);
    await handle.migrate();
    const after = await countAppliedMigrations(handle.db);
    logger.info('migrations complete', {
      kind: handle.kind,
      applied: after - before,
      recorded: after,
      available: availableMigrations(),
    });
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[arena:db] migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
