import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation only needs the schema, not a live database, so no DATABASE_URL is required
 * here: `pnpm db:generate` works offline. Applying migrations is done by `createDb().migrate()`
 * (see src/client.ts) or `pnpm db:migrate`, both of which read DATABASE_URL / ARENA_DATA_DIR.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: false,
});
