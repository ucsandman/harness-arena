/**
 * Imported first by every web test: an in-memory PGlite database (zero setup, nothing on disk) and a
 * fixed public URL, so route handlers behave identically on Windows and Linux and cost nothing.
 */
process.env.DATABASE_URL = 'pglite://memory';
process.env.ARENA_WEB_URL = 'http://localhost:3000';
delete process.env.ARENA_DATA_DIR;

export const WEB_URL = 'http://localhost:3000';
