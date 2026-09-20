# @harness-arena/web

The Harness Arena web app: marketing pages, battle reports (live and replay), harness import,
harness profiles with badges and head-to-head, leaderboards, benchmark packs, experiments, challenges,
tournaments, docs, accounts, device login, and the API the `arena` CLI talks to.

The web app never executes a harness, never clones a repository and never touches a provider
credential. Battles run on the user's machine; this app stores what they choose to upload.

## Run it locally

From the repository root:

```bash
pnpm build:packages                                   # workspace packages -> dist
pnpm --filter @harness-arena/database run seed        # agent catalog + the demo battle
ARENA_DEV_LOGIN=1 pnpm --filter @harness-arena/web run dev
```

On PowerShell, set the variable first:

```powershell
$env:ARENA_DEV_LOGIN = "1"; pnpm --filter @harness-arena/web run dev
```

Then open http://localhost:3000. With the seed loaded, the landing page renders the seeded demo
battle from the database (it falls back to `lib/sample-battle.ts` when nothing is seeded; both are
labelled as demo data).

### Database

`DATABASE_URL` empty (the default) uses embedded PGlite under `./.data/arena-pglite`, so there is
nothing to install. Point `DATABASE_URL` at `postgres://…` for a real server.

Two things to know about seeding into PGlite:

- The PGlite directory is relative to the **current working directory**, and `pnpm --filter` runs the
  seed inside `packages/database`. Give both processes the same absolute `ARENA_DATA_DIR` so the seed
  and the web app use one store.
- PGlite does not create missing parent directories, so create the folder once.

```bash
mkdir -p apps/web/.data/arena-pglite
ARENA_DATA_DIR="$PWD/apps/web/.data/arena-pglite" pnpm --filter @harness-arena/database run seed
ARENA_DATA_DIR="$PWD/apps/web/.data/arena-pglite" pnpm --filter @harness-arena/web run dev
```

The seed is idempotent; re-running it changes nothing. It prints what it loaded, for example
`demo battle seeded {"battleId":"btl_…","events":554,"artifacts":4}`.

With Postgres (`DATABASE_URL=postgres://…`) none of that applies: both processes talk to the server.

### Environment

See `.env.example` at the repository root. Nothing here is required for a local read-only run.

| Variable                   | Effect                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ARENA_WEB_URL`            | public base URL, used for OAuth callbacks, device links and CLI-facing URLs                                                        |
| `DATABASE_URL`             | Postgres URL; empty means embedded PGlite in `./.data`                                                                             |
| `GITHUB_CLIENT_ID`         | GitHub OAuth app; the sign-in button explains itself when unset                                                                    |
| `GITHUB_CLIENT_SECRET`     | GitHub OAuth app secret (server only)                                                                                              |
| `GITHUB_INSPECT_TOKEN`     | optional read-only token that raises the GitHub API rate limit for inspection                                                      |
| `ARENA_DEV_LOGIN`          | `1` adds a local sign-in form on `/login`; ignored when `NODE_ENV=production`                                                      |
| `ARENA_TRUSTED_PROXY_HOPS` | reverse proxies in front of this app that append to `x-forwarded-for`; `0` (the default) means the header is untrusted and ignored |

## Sign in

- **GitHub OAuth**: create an app with callback `<ARENA_WEB_URL>/api/auth/github/callback`, set
  `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
- **Local dev**: `ARENA_DEV_LOGIN=1` shows "Sign in as a local dev user" on `/login`. The route
  (`POST /api/auth/dev`) answers 404 in production, and a test proves it.

## Device login (how the CLI connects)

1. `arena login` → `POST /api/v1/device/code` returns a long device code and a short user code.
2. The CLI prints the user code and opens `/device?code=ABCD-1234`.
3. The signed-in human approves; the CLI's next `POST /api/v1/device/token` receives a token
   (`arena_dev_…`) **once**. Only its sha256 and an 8-character prefix are stored.
4. Tokens are listed and revocable on `/settings`, or by the device itself with
   `DELETE /api/v1/devices/current`.

## Pages

| Route                                               | What it shows                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/`                                                 | landing page, rendering the seeded demo battle                                             |
| `/battles`, `/battles/:id`                          | the battle feed and one report, live or replayed                                           |
| `/battles/new`                                      | build a battle spec in the browser and hand it to the CLI                                  |
| `/leaderboard`                                      | ranked harnesses per category and pool, provisional rows kept separate                     |
| `/harnesses`, `/harnesses/:slug`                    | the catalogue and one harness profile: ratings, categories, efficiency, versions, insights |
| `/harnesses/:slug/vs/:other`                        | the head-to-head record between two harnesses                                              |
| `/harnesses/import`                                 | import a harness from GitHub (inspection only, nothing is executed)                        |
| `/benchmarks`, `/benchmarks/:slug`                  | published benchmark packs and what is in one                                               |
| `/experiments`, `/experiments/:id`                  | experiments and their summaries, each conclusion with its sample                           |
| `/challenges`, `/challenges/:id`, `/challenges/new` | open challenges, one challenge, and creating one                                           |
| `/tournaments`                                      | brackets and how each match settled                                                        |
| `/bounties`, `/bounties/:id`, `/bounties/new`       | open bounties, one bounty with its submissions, and creating one                           |
| `/components`, `/components/:slug`                  | the component catalogue and what experiments say about each                                |
| `/explore`                                          | discovery across harnesses, challenges, benchmarks and experiments                         |
| `/dashboard`, `/settings`                           | the signed-in account: its battles, its devices                                            |
| `/device`, `/login`                                 | device-code approval and sign-in                                                           |
| `/docs`, `/privacy`, `/security`                    | the rendered `docs/` tree and the policy pages                                             |

Arena hosts no runner, and the data layer says so rather than leaving it to the page copy: every
challenge, tournament and bounty response carries `ARENA_EXECUTION_NOTE` from the protocol verbatim,
and the leaderboard response carries `poolEmpty`, so the verified pool reads as empty instead of
rendering an empty table as a result.

## API (v1)

All of it is validated against `@harness-arena/protocol`, bearer-authenticated with a device token,
rate limited (120 requests/minute per token, and per client address when `ARENA_TRUSTED_PROXY_HOPS`
says a proxy in front of this app writes one; callers with no address this deployment trusts share
one wider window per route), and body-capped at `API_LIMITS.maxBodyBytes` while the body is read, so
an oversized or chunked upload is refused instead of buffered. Errors are always
`{"error":{"code","message"}}` and never a stack trace.

An uploaded battle is stored as self-reported (`verification.kind: "local"`, not eligible for the
verified pool) whatever the record claims: the server decides provenance, never the payload, so the
verified ratings pool stays empty until Arena executes battles itself. Ratings move only on a public,
completed, non-demo battle with a decided winner, so publishing a battle is what counts it.

| Route                           | Method | Notes                                            |
| ------------------------------- | ------ | ------------------------------------------------ |
| `/api/v1/device/code`           | POST   | public, starts a device login                    |
| `/api/v1/device/token`          | POST   | public, polls for the token                      |
| `/api/v1/me`                    | GET    | bearer                                           |
| `/api/v1/devices/current`       | DELETE | bearer, self-revoke                              |
| `/api/v1/battles`               | GET    | bearer, the caller's battles                     |
| `/api/v1/battles`               | POST   | bearer, upload a record or create a pending spec |
| `/api/v1/battles/:id`           | GET    | visibility-checked; `?events=1`, `?format=json`  |
| `/api/v1/battles/:id`           | PATCH  | bearer, owner only                               |
| `/api/v1/battles/:id/events`    | POST   | bearer, owner only; duplicate `seq` is a no-op   |
| `/api/v1/battles/:id/artifacts` | POST   | bearer, owner only                               |
| `/api/v1/battles/:id/stream`    | GET    | Server-sent events, visibility-checked           |

Public reads, no bearer needed. Each one is cached and repeats where the numbers came from:

| Route                               | Method | Notes                                                                                  |
| ----------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `/api/v1/leaderboard`               | GET    | `?category=&pool=&agent=&limit=`; says when a pool is empty                            |
| `/api/v1/harnesses/:slug`           | GET    | the whole profile: ratings, categories, efficiency, versions, lineage, insights        |
| `/api/v1/harnesses/:slug/history`   | GET    | `?category=&pool=&agent=`; the rating events behind the curve                          |
| `/api/v1/harnesses/:slug/vs/:other` | GET    | `?agent=&category=&pool=&benchmark=&commit=&since=&until=`                             |
| `/api/v1/harnesses/:slug/insights`  | GET    | deterministic sentences, each with its sample                                          |
| `/api/v1/harnesses/:slug/lineage`   | GET    | declared ancestry only; Arena never infers one                                         |
| `/api/v1/badges/:slug/:kind`        | GET    | SVG for a README: rating, verified-rating, win-rate, correctness, battles, tokens, top |
| `/api/v1/benchmarks`                | GET    | published packs                                                                        |
| `/api/v1/benchmarks/:slug`          | GET    | one pack, `?version=bmv_…` for an exact content version                                |
| `/api/v1/components`                | GET    | the component catalogue and what experiments say about each                            |
| `/api/v1/components/:slug`          | GET    | one component, with the harnesses and experiments behind it                            |

Bearer-authenticated writes for the competitive layer. None of them executes anything: the battles are
run locally by whoever accepts the work and uploaded afterwards.

| Route                              | Method    | Notes                                                                               |
| ---------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `/api/v1/benchmarks`               | POST      | publish a pack version; identical content is a no-op                                |
| `/api/v1/challenges`               | GET       | open challenges, `?status=&harness=&limit=`                                         |
| `/api/v1/challenges`               | POST      | create a challenge (a definition, nothing runs)                                     |
| `/api/v1/challenges/:id`           | GET       | one challenge, visibility-checked                                                   |
| `/api/v1/challenges/:id/accept`    | POST      | take a challenge on, then run it locally                                            |
| `/api/v1/challenges/:id/cancel`    | POST      | creator only                                                                        |
| `/api/v1/experiments`              | GET       | experiments; POST creates one                                                       |
| `/api/v1/experiments/:id`          | GET       | one experiment and its summary                                                      |
| `/api/v1/experiments/:id/battles`  | POST      | link an uploaded battle to the experiment                                           |
| `/api/v1/experiments/:id/finalize` | POST      | compute the summary from the linked battles                                         |
| `/api/v1/tournaments`              | GET       | brackets; POST creates one                                                          |
| `/api/v1/tournaments/:id`          | GET       | one bracket, its matches and how each settled                                       |
| `/api/v1/tournaments/:id/start`    | POST      | seed the bracket and open it for play                                               |
| `/api/v1/bounties`                 | GET       | open bounties; POST creates one                                                     |
| `/api/v1/bounties/:id`             | GET       | one bounty and its submissions                                                      |
| `/api/v1/bounties/:id/submissions` | GET, POST | submissions for a bounty, and claiming it with the battles that meet its conditions |

## Tests

```bash
pnpm exec vitest run apps/web            # from the repository root
```

Every web test runs against `pglite://memory`, calls the route handlers directly, injects `fetch`
where GitHub is involved, and costs nothing.
