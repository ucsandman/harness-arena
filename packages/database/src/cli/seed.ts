/**
 * Seed the database. Run with `pnpm db:seed` (tsx). Idempotent: every write is an upsert.
 *
 * 1. the agent catalog (the CLIs Arena can drive)
 * 2. the demo battle from examples/demo/, when it has been generated (`pnpm demo`)
 */
import path from 'node:path';
import { createDb } from '../client.js';
import { demoFilesExist, demoFilesFor, findRepoRoot, seedAgents, seedDemoBattle } from '../seed.js';

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
    await handle.migrate();
    logger.info('agents seeded', { count: await seedAgents(handle.db) });

    const root = findRepoRoot();
    const files = root ? demoFilesFor(root) : null;
    if (!files || !demoFilesExist(files)) {
      logger.info('no demo battle found; generate one with "pnpm demo", then re-run "pnpm db:seed"', {
        looked: files ? path.relative(root ?? '.', files.recordFile) : 'workspace root not found',
      });
      return;
    }
    logger.info('demo battle seeded', { ...(await seedDemoBattle(handle.db, files)) });
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[arena:db] seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
