# Contributing

Thanks for helping build the referee. This page gets you from clone to green in a few minutes.

## Setup

```bash
git clone https://github.com/harness-arena/harness-arena
cd harness-arena
pnpm install          # Node >= 22, pnpm 10 (corepack enable)
pnpm build:packages   # compiles packages/* to dist (the CLI and the web app import from dist)
pnpm test             # vitest, $0 in model usage: every test uses the fake adapter or fixtures
pnpm dev              # web app on http://localhost:3000 with an embedded PGlite database
```

Useful commands:

| Command                                       | What it does                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format`                   | ESLint (flat config) / Prettier                                              |
| `pnpm typecheck`                              | `tsc --noEmit` over every package and the web app                            |
| `pnpm verify`                                 | lint + typecheck + test + build, what CI runs                                |
| `pnpm demo`                                   | builds packages and runs the deterministic demo battle with the fake adapter |
| `pnpm arena -- <args>`                        | runs the CLI from `packages/cli/dist`                                        |
| `pnpm db:generate` / `db:migrate` / `db:seed` | Drizzle migrations and the demo seed                                         |

## Repository map

See `docs/ARCHITECTURE.md`. Short version: `protocol` (schemas) ← `adapters`, `harness`, `evaluator`,
`database` ← `core` (engine) ← `cli`, `mcp`; `apps/web` reads `protocol`, `database`, `harness`.

## Conventions

- TypeScript, ESM, strict. Zod 4 for anything that crosses a boundary.
- Tests live in `packages/<pkg>/test/*.test.ts` and `apps/web/test/`. They run on Windows and Linux in CI.
  Use `node:path` and `os.tmpdir()`, never hardcode separators, never shell-interpolate arguments.
- **No paid model calls in tests.** Use `FakeAdapter`, injected `ProcessRunner`, or the fixtures under
  `packages/adapters/fixtures`. Real CLI fixtures are labeled with their capture date; synthetic ones say so.
- Every metric carries a status (`observed`, `calculated`, `estimated`, `unavailable`). Never invent a number.
- Every event carries `source.native` and a `confidence`.
- Security: read `docs/SECURITY.md` before touching git, process spawning, harness application, ingest, or auth.

## Adding an agent adapter

1. Create `packages/adapters/src/<agent>/parser.ts` (pure: provider lines → protocol events) and `adapter.ts` (implements `AgentAdapter`).
2. Capture a real fixture with the CLI's streaming output, redact paths, and add it under `fixtures/<agent>/`.
3. Declare `capabilities()` honestly. If the CLI does not report cost, say `unavailable`.
4. Deliver the prompt on stdin when the CLI supports it. Never pass it through a shell.
5. Register it in `builtinAdapters` and document it in `docs/ADAPTERS.md`.

## Adding an evaluator

Implement the `Evaluator` interface in `packages/evaluator/src/evaluators/`, add it to `builtinEvaluators`,
and give it tests for pass, fail, and error paths. Deterministic evaluators decide verdicts; subjective ones
(LLM judges) never override them.

## Pull requests

- One feature per PR. Include tests. Keep `pnpm verify` green on both operating systems.
- Update the docs that describe what you changed; the web app renders `docs/*.md` directly.
- Never commit `.env`, tokens, or fixtures containing real paths or usernames.
