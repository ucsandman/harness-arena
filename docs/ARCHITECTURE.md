# Architecture

Harness Arena runs two AI coding-agent setups ("harnesses") against the same task under identical starting
conditions, captures telemetry, evaluates the results deterministically, and renders a battle report.

The economic principle behind every design choice: **we sell the referee, not the electricity.** Model
usage is paid by the user through the CLIs and subscriptions they already have. Arena never proxies model
traffic and never touches provider credentials.

```
arena CLI ──▶ official agent CLI (claude / codex / gemini / opencode) ──▶ provider subscription
   │
   ├── workspaces (git worktrees owned by Arena, never the user's checkout)
   ├── events.ndjson (normalized, versioned event protocol)
   ├── evaluation (repo tests, build, assertions, diff signals; LLM judge optional + labeled)
   ├── report.html (self-contained, works offline)
   └── optional upload to the web app (device token, privacy-filtered)
```

## Monorepo layout

| Path                 | Package                    | Role                                                                                                                                                                                                            |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`  | `@harness-arena/protocol`  | Zod schemas and types for everything that crosses a boundary: events, battle spec/record, `arena.yaml`, metrics, evaluation, API. No runtime deps except zod.                                                   |
| `packages/adapters`  | `@harness-arena/adapters`  | `AgentAdapter` interface, detection, and adapters for Claude Code, Codex, Gemini CLI, OpenCode, plus the deterministic `fake` adapter used by tests and demo.                                                   |
| `packages/harness`   | `@harness-arena/harness`   | Harness resolution: GitHub URL parsing, repository inspection (works on a file-listing abstraction so the web server never executes repo code), `arena.yaml` loading, applying a harness to a workspace.        |
| `packages/evaluator` | `@harness-arena/evaluator` | Evaluator plugins (repo tests, build/lint/typecheck, task assertions, diff signals, optional blind LLM judge) and the verdict engine.                                                                           |
| `packages/core`      | `@harness-arena/core`      | Battle engine: state store (`~/.harness-arena`), git workspace manager, process runner, event bus with redaction and size caps, metrics aggregation, insights, local HTML report, structured logging, uploader. |
| `packages/database`  | `@harness-arena/database`  | Drizzle schema + migrations. Postgres in production, embedded PGlite for dev/tests (zero setup).                                                                                                                |
| `packages/cli`       | `harness-arena`            | The `arena` CLI (interactive and non-interactive). Thin over core.                                                                                                                                              |
| `packages/mcp`       | `@harness-arena/mcp`       | MCP server exposing battles to MCP clients. An interface into Arena, never the execution engine.                                                                                                                |
| `apps/web`           | `@harness-arena/web`       | Next.js app: marketing, battle pages (live + replay), harness import/profile, leaderboard, docs, auth, device login, ingestion API. Deployable separately from local execution.                                 |
| `examples/`          |                            | Example harness with `arena.yaml`, example battle specs, fixtures.                                                                                                                                              |
| `docs/`              |                            | Architecture, protocol, adapters, security, contributing. Rendered by the web app under `/docs`.                                                                                                                |

Dependency direction (no cycles): `protocol` ← `adapters`, `harness`, `evaluator`, `database` ← `core` ← `cli`, `mcp`. `web` depends on `protocol`, `database`, `harness` (inspection only).

## Three execution modes

1. **Local subscription battle (MVP default).** `arena battle` on the user's machine, using their authenticated CLIs. Arena spawns the official CLI process, feeds the task on stdin, parses the CLI's own streaming output.
2. **Local BYOK.** Same engine; the user may set provider API keys in their own environment. Arena passes the environment through to the CLI but never reads, logs, or uploads key values (the redactor scrubs any env value that appears in output).
3. **Verified cloud battle (designed, not hosted).** `BattleSpec.mode = 'cloud'` and `BattleRecord.verification` describe a battle executed in identical sandboxes by Arena. The data model, ratings pool separation (`community` vs `verified`), and API accept it today. No cloud runner ships; nothing in this repo can spend model credits on Arena's behalf.

## Battle lifecycle

```
pending ─▶ preparing ─▶ running ─▶ evaluating ─▶ completed
                 └────────┴──────────┴──────────▶ failed | cancelled
```

1. **Resolve.** Task (prompt or GitHub issue → prompt), repository (URL or local path → exact commit), harnesses (URL/path/`vanilla` → checkout + commit + manifest or auto-detected files), agents (detect + validate).
2. **Prepare workspaces.** Arena keeps a bare mirror per repository under `ARENA_HOME/repos/`. Each run gets its own detached `git worktree` of the mirror at the resolved commit. The user's checkout is only ever _read_ (fetched from). Git hooks are disabled for every git invocation Arena makes (`core.hooksPath` pointed at an empty directory).
3. **Apply harness.** Files declared by `arena.yaml` (or auto-detected: `CLAUDE.md`, `.claude/`, `AGENTS.md`, `.codex/`, `GEMINI.md`, `.gemini/`, `opencode.json`, `.opencode/`, `.mcp.json`) are copied into the workspace with path-containment and symlink checks. `install`/`prepare` commands run only after the user has trusted the harness (interactive prompt or `--trust`).
4. **Baseline evaluation.** If a test command is configured, it runs once on the untouched workspace so regressions can be distinguished from pre-existing failures.
5. **Execute.** Runs are sequential by default (fairness on shared CPU; `--parallel` opts in). The adapter builds a fixed argv (never shell-interpolated; the prompt goes over stdin), spawns the CLI, and translates its native stream into protocol events. Every event passes through the redactor and size caps before it is written to `events.ndjson` or uploaded.
6. **Collect.** `git diff` + `--numstat` against the start commit produce the patch, `files_changed`, `lines_added/removed` (status `calculated`). The final assistant message and exit status are recorded.
7. **Evaluate.** Evaluator plugins run per side; the verdict engine combines results. Winner only when deterministic evidence supports it; otherwise `tie` or `inconclusive` with reasons.
8. **Report.** `battle.json`, `events.ndjson`, `report.html` under `ARENA_HOME/battles/<id>/`. With a device token and `privacy.upload != 'none'`, the same data (filtered) streams to the web app.

Interruption: SIGINT/SIGTERM or timeout → the child process tree is killed (`taskkill /T` on Windows, process-group kill elsewhere), the run is marked `interrupted`/`timed_out`, worktrees are removed, and the record is flushed so `arena status` and `arena replay` still work.

## Telemetry honesty

Every metric carries a status: `observed` (reported by the CLI), `calculated` (derived by Arena from observed data, e.g. git diff), `estimated` (heuristic, labeled), or `unavailable` (the CLI does not expose it). Every event carries `source.native` (the provider's own event type) and a `confidence`. Adapters declare `capabilities()` so the UI can say "Codex does not report cost" instead of showing $0.

Verified against real CLI output on 2026-09-19 (Windows 11):

- Claude Code 2.1.278 `--output-format stream-json --verbose` reports per-message usage, `total_cost_usd` (list-price estimate, not a subscription charge), `num_turns`, `subagent_stats`, tool calls and results. Fixture: `packages/adapters/fixtures/claude-code/success.ndjson`.
- Codex 0.154.0 `exec --json` emits `thread.started`, `turn.started`, `item.*`, `turn.completed{usage}` / `turn.failed`, `error`. Captured failure fixture (usage limit): `packages/adapters/fixtures/codex/usage-limit.ndjson`.
- Gemini CLI 0.55.1 `--output-format stream-json`. Captured failure fixture (auth ineligible): `packages/adapters/fixtures/gemini-cli/auth-error.txt`.
- OpenCode 2.0.4 `run --format json`. Captured failure fixture (provider error): `packages/adapters/fixtures/opencode/provider-error.ndjson`.

## Fairness controls

- Same commit, same task text, same limits, same evaluation for both sides.
- User-level agent configuration is excluded where the CLI allows it (Claude Code: `--setting-sources project,local --strict-mcp-config`; Codex: `--ignore-user-config --ignore-rules`) so the harness under test is the _only_ difference. Where a CLI cannot exclude user config, `EnvironmentInfo` records that and the report says so.
- Harness B never sees harness A's workspace.
- Sequential execution by default.

## Web app and realtime

The web app never executes harness or repository code. GitHub import inspects repositories through the GitHub REST API (tree + selected file contents) using the same `inspect()` function the CLI runs over the local filesystem.

Realtime: the CLI POSTs event batches; the battle page subscribes to a Server-Sent Events endpoint that tails the `events` table by sequence number. This works on serverless hosts without a message broker.

Auth: GitHub OAuth (authorization-code flow with a state cookie) → server-side session. CLI association uses a device-code flow (`arena login`): the CLI shows a short code, the browser approves it, and the CLI receives a revocable device token stored with mode 0600 in `ARENA_HOME/config.json`. Tokens are stored hashed. Provider credentials are never involved.

## Ratings

`ratings` are per (harness, agent, category, pool). Pools: `community` (local, self-reported battles) and `verified` (future cloud battles). Community results never feed the verified pool. Ratings display as provisional below a minimum sample size, and the leaderboard is a foundation, not a claim.

## Renaming

The product name appears in: package scopes (`@harness-arena/*`), the CLI bin names (`arena`, `harness-arena`), `ARENA_*` env vars, and `apps/web/lib/brand.ts`. Everything user-visible on the web reads from `brand.ts`.
