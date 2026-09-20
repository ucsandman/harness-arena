# Harness Arena

Live: **https://harness-arena-xi.vercel.app** (community leaderboard, profiles, badges, challenges, tournaments, bounties). Battles run on your machine; the site only stores what you upload.

Run two AI coding-agent setups on the same task, on your own machine, with the coding-agent CLIs you already pay for. Harness Arena captures what each side did, evaluates the result deterministically, and renders a battle report you can keep private or share.

A **harness** is everything around the model: `CLAUDE.md`, `AGENTS.md`, hooks, skills, subagents, MCP servers, settings. Arena is where harnesses compete.

- **No model costs for anyone but you.** Battles run through the official CLIs (Claude Code, Codex CLI, Gemini CLI, OpenCode) with your existing login. Arena never reads, copies, proxies or uploads those credentials.
- **Telemetry is never fabricated.** Every metric carries `observed`, `calculated`, `estimated` or `unavailable`. A CLI that does not report cost shows `n/a`, never `0`.
- **Correctness first. Efficiency breaks clean ties.** Tests, assertions and build checks gate the verdict; a broken run never beats a correct one. Between equally correct sides, weighted tokens, cost and wall time (40/35/25, at least 5% apart) pick the winner, otherwise `tie`. Every verdict ships its stage-by-stage breakdown. An LLM judge is modeled but off by default and always labeled subjective.
- **Fair by construction.** Same commit, fresh git worktrees, identical prompt, hooks disabled, your working tree never touched.

## Quick start

```bash
pnpm install
pnpm build:packages
node packages/cli/dist/bin.js demo --open
```

The demo runs a deterministic fake battle ("Agnostic AI" vs "Vanilla Claude Code" fixing a session-expiry bug) with no model involved, then opens the report. Everything is labeled demo and never counts toward ratings.

A real battle with the Claude Code CLI you are logged into:

```bash
node packages/cli/dist/bin.js battle https://github.com/you/your-harness vanilla \
  --agent claude-code --repo https://github.com/you/some-repo \
  --task "Fix the flaky retry logic in src/http.ts" --tests "npm test"
```

Arena shows what the harness would apply and which commands it wants to run before anything executes. Commands run only after you trust the harness (`--trust` or the interactive prompt).

## What is in the box

| Path                 | Purpose                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`  | Zod schemas: battle spec and record, versioned event protocol, metrics, `arena.yaml`, API                                                                                                                                              |
| `packages/adapters`  | One adapter per agent CLI plus a fake adapter that replays fixtures for tests and the demo                                                                                                                                             |
| `packages/harness`   | Harness sources (local, git, GitHub API), inspection, compatibility report, apply                                                                                                                                                      |
| `packages/evaluator` | Deterministic evaluators (repo tests, assertions, build, diff scope) and the verdict                                                                                                                                                   |
| `packages/core`      | Battle engine: worktrees, process lifecycle, telemetry, redaction, report, uploader                                                                                                                                                    |
| `packages/cli`       | `arena`: battle, run, demo, replay, status, list, agents, harnesses, login, doctor, regression, clean, plus the competitive commands (benchmark, experiment, compare, challenge, tournament, leaderboard, rating, profile, h2h, badge) |
| `packages/mcp`       | MCP server exposing Arena as tools for any agent: battles, benchmark packs, experiments, challenges, ratings                                                                                                                           |
| `packages/database`  | Drizzle schema, migrations, queries, Glicko ratings with their audit trail, head-to-head, insights, benchmarks, challenges, tournaments, bounties, lineage, components (PGlite for dev and tests, Postgres in production)              |
| `apps/web`           | Next.js site: battles feed, live and replayed reports, harness import, profiles and badges, leaderboards, challenges, tournaments, bounties, device login                                                                              |
| `docs/`              | Architecture, protocol, harness protocol, CLI, adapters, verdicts, ratings, benchmarks, experiments, challenges, lineage, security, privacy, contributing                                                                              |
| `examples/`          | Battle specs, an example harness with `arena.yaml`, the exported demo battle                                                                                                                                                           |

## CLI

```
arena                       welcome screen: detected agents, harness config in cwd
arena battle A B ...        run a battle between harness A and harness B
arena run <battle.json>     run a battle from a spec file, or --battle <id> from the server
arena demo [--open]         deterministic demo battle, no model involved
arena replay <id>           rebuild and open a report from stored telemetry
arena status <id> [--watch] battle status and verdict
arena list                  battles in ARENA_HOME
arena agents                which agent CLIs are installed and their versions
arena harnesses inspect X   compatibility report for a GitHub URL or local path (no execution)
arena login / logout        device-code login to the web app (optional)
arena doctor [--fix]        environment check; --fix removes orphaned workspaces and stale locks
arena regression <dir>      CI mode: baseline vs candidate over a directory of specs
arena benchmark <cmd>       benchmark packs: list, show, validate, publish, run
arena experiment run        control vs treatment over a pack, with the statistics attached
arena compare <harness>     did this harness get better between two commits?
arena challenge <cmd>       create a challenge, or run one on this machine
arena tournament <cmd>      read a bracket, or play its pending matches here
arena leaderboard           ranked harnesses for a category and pool
arena rating <slug>         one rating, with --history for the events behind it
arena profile <slug>        everything the server knows about one harness
arena h2h <slug> <other>    the record between two harnesses
arena badge <slug>          badge URL and Markdown snippet for a README
arena clean                 delete old battle directories under ARENA_HOME
```

Every command takes `--json` (exactly one JSON document on stdout) and `--home <dir>` (defaults to `~/.harness-arena`). Full reference: [docs/CLI.md](docs/CLI.md).

Exit codes: `0` completed, `1` usage or environment error, `2` battle failed or cancelled, `3` harness not trusted.

## Modes

| Mode               | Who runs the agent         | Credentials                                    | Status              |
| ------------------ | -------------------------- | ---------------------------------------------- | ------------------- |
| Local subscription | Your machine, your CLI     | Whatever the CLI already has; Arena reads none | Default, shipped    |
| Local BYOK         | Your machine, your API key | `agent.env` in the spec, values never stored   | Shipped             |
| Verified cloud     | Arena-run sandbox          | User-provided key or credits                   | Modeled, not hosted |

Ratings from local battles land in the **community** pool. The **verified** pool exists in the schema and on the leaderboard page but stays empty until verified execution exists.

## Compete

Arena hosts no runner. Everything below is a definition held on the server; the battles behind it run
on a contributor machine, with the CLI and subscription that person already has, and the record is
uploaded afterwards. That is why every result is labelled community.

**Leaderboards.** `arena leaderboard --category debugging --pool community` ranks harnesses per
(harness, agent, category, pool). The **community** pool holds self-reported local battles. The
**verified** pool holds battles Arena executed itself under standardised conditions, and it is empty:
no hosted runner exists, and the leaderboard says so instead of showing an empty table as a result. A
rating with fewer than 10 decided battles, or a deviation above 120, is listed as provisional and
never ranked.

**Harness profiles and badges.** `arena profile <slug>` prints ratings per agent and category,
per-category correctness with its sample, median token, cost and duration ratios against real
opponents, the commits that were tested, and deterministic insights that each name the number of
battles behind them. `arena badge <slug> --kind win-rate --markdown` prints a snippet for a README:

```markdown
![Arena rating](https://<site>/api/v1/badges/<slug>/rating)
```

**Challenges.** `arena challenge create --a . --b vanilla --agent claude-code --task ./task.md --repo <url>`
publishes a matchup. Nobody has run anything yet; whoever takes it on runs
`arena challenge run <id>` on their own machine and uploads the battle, which the server verifies
against the challenge before linking it.

**Benchmark packs.** A pack is a reusable set of tasks, immutable by content hash, so the same file
always publishes as the same `bmv_…` version id and two people can prove they ran the same work:
`arena benchmark validate ./packs/acme.json`, `arena benchmark publish ./packs/acme.json`,
`arena benchmark run acme-pack --a . --b vanilla --agent claude-code --trials 3`.

**Experiments.** A regression asks whether a harness got better between two commits:
`arena compare . --from v0.3.0 --to HEAD --benchmark acme-pack --trials 3`. An ablation asks what one
component is worth:
`arena experiment run --kind ablation --control . --treatment . --component skill:tests-first --benchmark acme-pack`.
Both report correctness, tokens, cost and duration with their denominators, and conclusions that name
their sample.

**Tournaments and bounties.** `arena tournament show <slug>` reads a single-elimination bracket;
`arena tournament play <slug>` runs its pending matches here and uploads them, which is what settles
them. A bounty states a baseline and the conditions a submission must beat; Arena moves no money and
evaluates the conditions deterministically over the linked battles.

**How a rating is computed.** Every decided battle updates both sides with Glicko-1 from the same
pre-battle numbers, so a win over a strong, well-established opponent moves a rating more than a win
over a provisional one, and every change is an immutable `rating_events` row carrying the battle, the
exact harness commit, the opponent and the before and after numbers. Ratings age: the deviation grows
with inactivity, so a harness nobody has tested in months is shown with a wide interval instead of a
stale certainty ([docs/RATINGS.md](docs/RATINGS.md)).

**Anti-gaming.** A battle is fingerprinted over its task, repository commit, agents, models, harness
commits and evaluation, so re-running the same matchup is a repeated trial and earns no second rating
change; self-play, a harness with no resolved commit, deleted test files, demo data and an
inconclusive verdict all block a battle from the ratings outright. Softer signals (modified test
files, a dirty repository, different agents or models, parallel execution, custom efficiency weights)
are shown next to the result rather than hidden, and the integrity check that counts is the one the
server runs at upload, not the one the uploader sends.

## Web app

```bash
cp .env.example .env            # fill in what you use; the file stays untracked
pnpm build:packages
pnpm db:seed                    # loads examples/demo into the database
pnpm --filter @harness-arena/web run dev
```

Without `DATABASE_URL` the app and the seed use an embedded PGlite database in `ARENA_DATA_DIR` (set one absolute path for both). GitHub OAuth needs `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; for local work set `ARENA_DEV_LOGIN=1` to get a dev sign-in form instead. Details in [apps/web/README.md](apps/web/README.md).

### Deploy (Vercel + Neon)

The public instance is a Vercel project with root directory `apps/web` and build command `pnpm -w run build` (packages first, then `next build`), backed by a Neon Postgres database. Migrations run on the first request (`apps/web/lib/db.ts`), so a fresh database needs nothing but `DATABASE_URL`. Environment on Vercel: `DATABASE_URL`, `ARENA_WEB_URL`, `ARENA_SITE_URL`, `NEXT_PUBLIC_SITE_URL` (all three the public URL), `ARENA_TRUSTED_PROXY_HOPS=1` (Vercel is one proxy), and the GitHub OAuth pair. Seed the catalogue and the demo battle once with `DATABASE_URL=<url> pnpm db:seed`. Every push to `main` deploys after CI.

The CLI talks to the app through `POST /api/v1/device/code` and `/token` (device login), then `POST /api/v1/battles`, `.../events`, `.../artifacts` and `PATCH .../battles/:id`. What leaves your machine is governed by `privacy.upload` (`none`, `metrics`, `events`, `full`) and the exclusion list; see [docs/PRIVACY.md](docs/PRIVACY.md).

## MCP

```bash
claude mcp add harness-arena -- node /path/to/harness-arena/packages/mcp/dist/bin.js
```

Tools: `arena_list_agents`, `arena_list_battles`, `arena_get_battle`, `arena_get_results`, `arena_compare_runs`, `arena_list_harnesses`, `arena_inspect_harness`, `arena_start_battle`, `arena_render_report`, `arena_list_benchmarks`, `arena_run_benchmark`, `arena_run_experiment`, `arena_compare_versions`, `arena_get_experiment`, `arena_create_challenge`, `arena_get_challenge`, `arena_get_leaderboard`, `arena_get_harness_profile`, `arena_get_rating`, `arena_get_head_to_head`, `arena_get_insights`. The five read tools need no login and take the server from `ARENA_SERVER_URL` or from the URL `arena login` stored. See [packages/mcp/README.md](packages/mcp/README.md).

## Making a repository battle-ready

Arena detects `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/`, `.codex/`, `opencode.json` and friends at the root of a harness repository. A repository that assembles its harness some other way adds an `arena.yaml`:

```yaml
arena: 1
name: my-harness
agents: [claude-code, codex]
files: [CLAUDE.md, .claude/]
install:
  command: npm ci
prepare:
  command: node scripts/render-claude-md.js --out ${ARENA_WORKSPACE}
```

`install`, `prepare` and `cleanup` run on the battle runner's machine and only after that person trusts the harness. The full manifest is in [docs/HARNESS-PROTOCOL.md](docs/HARNESS-PROTOCOL.md) and a complete example in [examples/example-harness](examples/example-harness).

## Development

```bash
pnpm install
pnpm verify          # lint, typecheck, test, build
pnpm test            # vitest across every package; costs $0, uses the fake adapter
pnpm build           # packages, then the web app
```

Requirements: Node 22 or newer, pnpm 10, git. Windows, macOS and Linux are supported; CI runs on Ubuntu and Windows.

## Security and privacy

- Harness install commands never run without explicit trust, and never on the web server.
- Harness inspection over GitHub uses the REST API only: no clone, no execution, no token unless you set `GITHUB_INSPECT_TOKEN`.
- Agent `env` values live in memory for the child process only; records, reports, logs and uploads carry the names, never the values, and a redactor scrubs every string that leaves memory.
- Threat model and mitigations: [docs/SECURITY.md](docs/SECURITY.md). Data that leaves the machine: [docs/PRIVACY.md](docs/PRIVACY.md).

## Status

Local battles, the demo, the report, the CLI, the MCP server, the web app and the community leaderboard foundation are implemented and tested (see `pnpm test`). Only the Claude Code success path has been verified against a live CLI; Codex, Gemini and OpenCode adapters were built from real failure captures plus synthetic success fixtures and are marked accordingly in [docs/ADAPTERS.md](docs/ADAPTERS.md). Verified cloud execution, the LLM judge and paid tiers are modeled, not shipped.

License: MIT.
