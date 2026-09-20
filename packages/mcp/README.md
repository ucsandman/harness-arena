# @harness-arena/mcp

The MCP server for [Harness Arena](../../README.md): an interface that lets an MCP client run battles,
read results and inspect harnesses through the same engine the CLI and the web app use.

It is an interface, never the execution architecture. Every tool delegates to `@harness-arena/core`
(battles, state, report), `@harness-arena/adapters` (which agent CLIs exist and what each can observe) and
`@harness-arena/harness` (harness inspection). Battles run the user's own locally authenticated agent CLIs
on this machine: Arena pays no model costs and never reads or forwards provider credentials.

## Register it

Claude Code:

```
claude mcp add harness-arena -- npx -y @harness-arena/mcp
```

Any MCP client that takes a JSON config (`mcpServers` in Claude Desktop, Cursor, Windsurf, Zed):

```json
{
  "mcpServers": {
    "harness-arena": {
      "command": "npx",
      "args": ["-y", "@harness-arena/mcp"],
      "env": { "ARENA_HOME": "C:\\Users\\you\\.harness-arena" }
    }
  }
}
```

`ARENA_HOME` is optional; it defaults to `~/.harness-arena`, the same state directory the `arena` CLI uses,
so battles started in either place are visible from both. Transport is stdio: stdin and stdout carry
JSON-RPC and nothing else, and every diagnostic goes to stderr.

From a checkout of this repository, use the built binary directly:

```
node packages/mcp/dist/bin.js
```

## Tools

| Tool                    | What it does                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `arena_list_agents`     | Agent CLIs on this machine: installed, version, auth, and the capabilities map of what each one can report.        |
| `arena_list_battles`    | Battles under `ARENA_HOME`, newest first, with status, winner and both competitors. `{ limit }`                    |
| `arena_get_battle`      | The full battle record, optionally with the telemetry stream. `{ id, includeEvents, eventTypes, limit, afterSeq }` |
| `arena_get_results`     | Verdict, evaluation report and insights for one battle. `{ id }`                                                   |
| `arena_compare_runs`    | The side-by-side metric table: value plus status badge per side, better side, significance. `{ id }`               |
| `arena_list_harnesses`  | Harnesses already checked out under `ARENA_HOME/harnesses`, plus the bundled example harness when present.         |
| `arena_inspect_harness` | Inspect a local path, a `github.com` URL or `vanilla` without cloning or executing anything. `{ source, ref }`     |
| `arena_start_battle`    | Validate a spec and run one battle, returning `{ id, status }` to poll. `{ spec \| specPath, trust, waitMs }`      |
| `arena_render_report`   | Write the self-contained HTML report and return its path. `{ id, outPath }`                                        |

Benchmark packs and experiments, run on this machine the same way the CLI runs them:

| Tool                     | What it does                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arena_list_benchmarks`  | Benchmark packs available on this machine, with their tasks, categories, trials and content version id. `{ limit }`                                            |
| `arena_run_benchmark`    | Run every task of a pack as a battle between two harnesses, locally. `{ file \| slug, a, b, agent, trials, taskId, trust, waitMs }`                            |
| `arena_run_experiment`   | Control vs treatment over a pack, with the summary statistics attached. `{ kind, control, treatment, benchmark, taskId, agent, trials, title, trust, waitMs }` |
| `arena_compare_versions` | Did one harness get better between two commits: a regression experiment. `{ harness, from, to, benchmark, taskId, agent, trials, trust, waitMs }`              |
| `arena_get_experiment`   | An experiment this machine ran: its battles, its summary, and every conclusion with its sample. `{ id, limit }`                                                |

Server tools. These talk to an Arena server and execute nothing: a challenge is a definition, and
whoever accepts it runs it locally with `arena challenge run <id>`.

| Tool                        | What it does                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arena_create_challenge`    | Publish a harness-vs-harness challenge; needs `arena login`. `{ title, harnessA, harnessB, agentId, prompt, repository, benchmarkSlug, benchmarkVersionId, visibility, ratingEligible }` |
| `arena_get_challenge`       | One challenge: definition, status, sides, and the battles uploaded against it. `{ id }`                                                                                                  |
| `arena_get_leaderboard`     | Ranked harnesses for a category and pool, each rating with its deviation, sample and form. `{ category, pool, agentId, limit }`                                                          |
| `arena_get_harness_profile` | Everything the server holds about one harness: ratings, category performance, efficiency, versions, opponents, lineage, insights. `{ slug }`                                             |
| `arena_get_rating`          | One rating with its deviation and record, and with `history: true` the rating events behind it. `{ slug, agentId, category, pool, history }`                                             |
| `arena_get_head_to_head`    | The record between two harnesses under the filters given. `{ slug, opponent, agentId, category, pool }`                                                                                  |
| `arena_get_insights`        | The deterministic insights for one harness, each carrying the sample it rests on. `{ slug }`                                                                                             |

The five read tools need no login: they read public data. They take the server from `ARENA_SERVER_URL`,
else the URL `arena login` stored in `ARENA_HOME/config.json`, and refuse with that instruction when
neither exists rather than answering a rating question from memory. Every result they return is
community-reported, because contributors ran those battles themselves; the rating arithmetic is
documented at `/docs/ratings` on the server and in `docs/RATINGS.md`.

Every tool answers with two content blocks: a one-line human summary, then the structured JSON (also
attached as `structuredContent`). Errors come back as `isError` results with a message that says what to do
next, never as a silent empty answer.

Caps, so one answer cannot flood a client: `arena_get_battle` returns at most 2000 events (200 by default)
and reports `events.truncated` with the total, and you page on with `afterSeq` (send back the previous
answer's `events.nextAfterSeq`) to reach the tail of a long stream; `arena_list_harnesses` inspects at most
50 cached checkouts; any single JSON payload over 4 MB of UTF-8 is refused with guidance instead of
truncated.

## Trust model

- **Harness commands are refused by default.** A harness may declare `install`, `prepare` and `cleanup`
  commands in `arena.yaml`. `arena_start_battle` only allows them when that call passes `trust: true`.
  With `trust` false (the default) the battle fails with the exact commands in its error and nothing is
  executed: no install, no prepare, and `runs.<side>.harness.executedCommands` stays empty. Trust is
  per call; there is no environment variable and no persisted setting that can grant it. A
  `competitors.<side>.harness.trusted` field inside the spec is a client assertion, not consent:
  `arena_start_battle` clears it before the battle starts, so only that call's `trust` argument decides.
- **Show the commands first.** `arena_inspect_harness` reports `trustRequired` and `execution.commands`
  verbatim. Put those in front of the user before you ask for approval.
- **Inspection never executes.** A local harness is read from disk, a GitHub harness through the REST API.
  Nothing is cloned, copied or run. An `arena.yaml` can put a credential in `agentConfig.<agent>.env`: every
  tool answer keeps the variable names and replaces the values with `[REDACTED]`, the same treatment core
  gives a battle record.
- **One battle per server process.** A second `arena_start_battle` is refused and names the running battle
  so the client polls it with `arena_get_battle` instead of starting a competing run.
- **No credentials, no model spend, no uploads.** The server reads no provider credentials (a
  `GITHUB_TOKEN` in the environment is used only to read GitHub harness files), sets no privacy defaults of
  its own, and uploads nothing: `privacy.upload` in the spec governs, and the server passes no uploader.
- **Nothing of yours is overwritten.** `arena_render_report` refreshes the battle directory report and its
  own earlier output, but a destination that already exists and is not an Arena report is left untouched and
  the call fails naming the file; outside `ARENA_HOME` it writes only into a directory that already exists.
- **stdout is the protocol.** Logging goes to stderr, and no env value, token or prompt body is ever logged.

## Embedding

```ts
import { createArenaMcpServer } from '@harness-arena/mcp';

const arena = createArenaMcpServer({ home: '/tmp/arena-home' });
await arena.server.connect(transport);
// ...
await arena.close(); // aborts a running battle, waits for it, then closes the transport
```

`createArenaMcpServer({ home, registry, logger, deps, env })` takes an adapter registry (to expose a
different set of agents), a logger, and `deps` for injection in tests: `runBattle`, `detectAgents`,
`fetchImpl` (GitHub inspection) and `exampleHarnessDir`.

## Development

```
pnpm --filter @harness-arena/mcp run build
./node_modules/.bin/vitest run packages/mcp
```

The tests drive a real `Client` over `InMemoryTransport.createLinkedPair()` against a server pointed at a
temporary `ARENA_HOME`. They run a demo battle through core with the deterministic fake adapter, so the
suite costs nothing, needs no agent CLI and makes no network call.
