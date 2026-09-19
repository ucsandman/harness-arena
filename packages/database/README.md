# @harness-arena/database

Drizzle ORM schema, migrations and queries for Harness Arena. Postgres in production, embedded
[PGlite](https://pglite.dev) for development and tests (zero setup, no Docker).

The `BattleRecord` stored in `battles.record` is **authoritative**. Every other column and table
(runs, metrics, evaluations, harnesses, tasks, repositories) is a projection of it, written by
`upsertBattleFromRecord`. Re-uploading the same record converges instead of duplicating rows, which
is what lets the CLI patch a battle while it runs.

## Choosing a database

| `DATABASE_URL`                    | Driver                                        | Notes                                                   |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `postgres://…` / `postgresql://…` | `postgres` + `drizzle-orm/postgres-js`        | `max: 5`, `prepare: false` (Neon/pgBouncer safe)        |
| unset, or `pglite://<dir>`        | `@electric-sql/pglite` + `drizzle-orm/pglite` | persisted in `ARENA_DATA_DIR` or `./.data/arena-pglite` |
| `pglite://memory`                 | PGlite, in memory                             | used by the test suite                                  |

```ts
import { createDb, getDb, listBattles, upsertBattleFromRecord } from '@harness-arena/database';

// one-off handle
const arena = await createDb({ url: process.env.DATABASE_URL });
await arena.migrate();
await upsertBattleFromRecord(arena.db, { record, ownerUserId, visibility: 'public' });
await arena.close();

// process-wide handle for the web app: reads DATABASE_URL + ARENA_DATA_DIR, migrates once
const { db } = await getDb();
const feed = await listBattles(db, { limit: 20 });
```

Neither the connection url nor any environment value is ever logged; the optional logger only sees
the driver kind and whether the store is persisted.

## Migrations

```bash
pnpm db:generate   # drizzle-kit generate  (schema -> packages/database/drizzle/*.sql; no database needed)
pnpm db:migrate    # apply pending migrations, prints "applied N, recorded M of K"
pnpm db:seed       # agent catalog + the demo battle from examples/demo (idempotent)
```

`createDb().migrate()` runs the same SQL through the drizzle migrator, resolving `drizzle/` relative
to this package so it works from `src` (vitest, tsx) and from `dist` (published build).

Generation runs from the package because `drizzle-kit` is a local devDependency:

```bash
pnpm --filter @harness-arena/database exec drizzle-kit generate --config drizzle.config.ts --name <name>
```

## Tables

- **identity** — `users` (GitHub OAuth), `sessions` (id = sha256 of the cookie token), `device_codes`
  (RFC 8628-style CLI login), `devices` (revocable CLI tokens, stored hashed with a display prefix).
  No provider credential ever reaches this database.
- **catalog** — `agents` (the CLIs Arena drives), `harnesses` (`slug` = `owner--repo`, `vanilla`, or a
  slugified local name), `harness_versions` (one per commit), `repositories`, `tasks` (id = hash of
  the task content, so identical tasks are shared).
- **battles** — `battles`, `battle_runs` (one per side), `events` (primary key `(battle_id, seq)`, so a
  retried upload is a no-op), `metrics` (denormalized comparison table), `evaluations`, `artifacts`
  (diff / final response / report HTML).
- **ratings** — `ratings` per `(harness, agent, category, pool)` plus a `rating_events` audit trail
  that doubles as the per-battle idempotency key.

## Ratings

Elo, `K = 32`, on the battle verdict, with `deviation = max(50, 350 / sqrt(games + 1))` as a
documented confidence term (not a Glicko RD update). Below `RATING_MIN_SAMPLE` decided battles a
rating is provisional. `community` (self-reported local battles) and `verified` (Arena-executed
cloud battles) are separate pools and never mix; a battle is only eligible for `verified` when
`record.verification.eligible` is true. Demo battles and undecided verdicts never move a rating, and
`applyBattleToRatings` skips a battle it has already applied.

## Tests

```bash
pnpm exec vitest run packages/database
```

Every test runs against `pglite://memory` (or a temp directory under `os.tmpdir()`), spawns no agent
CLI and costs nothing.
