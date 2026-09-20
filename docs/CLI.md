# Getting started / CLI

The `arena` CLI runs a battle on **your** machine with **your** agent CLIs and **your** subscriptions.
Arena never proxies model traffic, never reads provider credentials, and never pays for model usage.

## Install

```bash
npm install -g harness-arena     # gives you `arena` and `harness-arena`
# or, without installing:
npx harness-arena demo
```

Requirements: Node 22 or newer, git on `PATH`, and at least one official agent CLI signed in
(Claude Code, Codex, Gemini CLI, OpenCode). `arena demo` needs none of them.

## First run

```bash
arena
```

On a terminal that prints:

```
  ██╗  ██╗  Harness Arena
  ██╔══██╗ battle two agent harnesses on the same task

  arena 0.1.0   home C:\Users\you\.harness-arena

Detected agents
  ✓ Claude Code      2.1.278, auth unknown
  ✓ Codex CLI        0.154.0, auth unknown
  ✗ Gemini CLI       not installed
  ✓ Fake agent (fixture replay)  fake-1.0.0, auth ok

Detected harness configuration here
  ✓ ~/.claude  user-level Claude Code config (excluded from battles where the CLI allows it)
  ✓ CLAUDE.md          1 file  CLAUDE.md
  ✓ Skills             3 files .claude/skills/tests-first/SKILL.md

? What would you like to do?
  › Run a battle      two harnesses, one task
    Run the demo      deterministic, no agent CLI needed
    Inspect a harness compatibility report, nothing executed
    Doctor            environment and leftovers
    Exit
```

`arena` with no arguments and no terminal (a pipe, a CI job) prints the help instead of a menu.

## Commands

Global option: `--home <dir>` overrides `ARENA_HOME` (default `~/.harness-arena`) for any command.
`--json` prints one JSON document on stdout and moves every human line to stderr, so
`arena … --json | jq` is always safe. `NO_COLOR=1` turns colour off.

### `arena battle [harnessA] [harnessB]`

Runs both sides on the same task, same commit, same limits, same evaluation. A harness is `vanilla`
(the agent CLI with its own defaults), a GitHub URL, or a local directory.

```bash
arena battle https://github.com/ucsandman/agnostic-ai vanilla \
  --agent claude-code --model sonnet \
  --repo . --tests "npm test" \
  --task "Fix the failing session-expiry test" \
  --timeout 20m --local-only
```

| Flag                                              | Meaning                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--agent <id>`                                    | agent CLI for both sides: `claude-code`, `codex`, `gemini-cli`, `opencode`, `fake`                            |
| `--agent-a <id>` / `--agent-b <id>`               | a different CLI per side                                                                                      |
| `--model <name>`                                  | model for both sides, passed to the CLI verbatim                                                              |
| `--model-a` / `--model-b`                         | per-side model                                                                                                |
| `--repo <url\|path>`                              | repository to work in; defaults to the working directory when it is a git repo; `empty` for a greenfield task |
| `--ref <ref>`                                     | branch, tag or commit both sides start from                                                                   |
| `--task <text>`                                   | the task, delivered to both sides verbatim                                                                    |
| `--task-file <path>`                              | read the task from a file                                                                                     |
| `--issue <ref>`                                   | use a GitHub issue: `owner/name#123`, an issue URL, or `123` with a GitHub `--repo`                           |
| `--tests <command>`                               | test command: runs once as a baseline before the agents and again after                                       |
| `--build <command>`                               | build/check command; repeat the flag for more than one                                                        |
| `--timeout <duration>`                            | per side: `20m`, `900s`, `1h30m`, `500ms`; a bare number is seconds                                           |
| `--max-turns <n>`                                 | stop a side after this many agent turns                                                                       |
| `--max-budget-usd <n>`                            | stop a side when the CLI reports this much spend                                                              |
| `--parallel`                                      | run both sides at once (faster, less fair on a shared CPU)                                                    |
| `--trust`                                         | approve harness install/prepare commands without asking                                                       |
| `--local-only`                                    | never upload: `privacy.upload` is forced to `none`, so no battle data leaves this machine                     |
| `--upload <level>`                                | `none`, `metrics`, `events`, `full` (see [Privacy](/docs/privacy))                                            |
| `--exclude <list>`                                | `prompts,model_outputs,command_output,file_contents,diffs,paths`                                              |
| `--visibility <level>`                            | `private` (default), `unlisted`, `public`                                                                     |
| `--title`, `--category`, `--label-a`, `--label-b` | presentation and ratings metadata                                                                             |
| `--keep-workspaces`                               | keep the two run workspaces for inspection instead of removing them                                           |
| `--open`                                          | open the HTML report when the battle finishes                                                                 |
| `--yes`                                           | accept defaults, never prompt (what CI wants)                                                                 |
| `--server <url>`                                  | Arena server for uploads; overrides `ARENA_SERVER_URL` and `config.json`                                      |
| `--json`                                          | machine-readable result on stdout                                                                             |

Anything missing is asked for on a terminal: harness A and B (vanilla, a GitHub URL, a local path, or
one you used recently), the agent (only CLIs that are actually installed), the repository, the task,
and the timeout.

**Disclosure and trust.** Before an interactive battle starts, Arena resolves both harnesses and
prints the files that will be copied into each workspace and every command the harness declares in
`arena.yaml`. Commands run only after you approve them (or with `--trust`). A non-interactive run
with an untrusted harness that declares commands stops with exit code 3 instead of running anything.

**While it runs** you get a live line per side: status, elapsed time and the last real event
(`tool Edit`, `command exit 0`, `tests 12 passed, 0 failed`) — driven by the event stream, not a
spinner that keeps moving while nothing happens.

**Afterwards**: the verdict, a metrics table for both sides (`n/a` where a CLI reports nothing —
never a fabricated `0`), the insights, the path of `report.html`, and the web URL when the battle was
uploaded.

Exit codes: `0` completed, `1` a usage or environment error, `2` the battle failed or was cancelled,
`3` the harness was not trusted.

### `arena run <battle.json>`

Runs a saved spec. `--trust`, `--local-only`, `--keep-workspaces`, `--open`, `--server <url>`,
`--json` and `--home` work as above.

```bash
arena run examples/battles/fake-quick.json --local-only
arena run --battle btl_7x0d9m2q4k8v1n3p        # a pending battle created in the web app
```

`--battle <id>` needs `arena login`; the spec is fetched with the device token and the battle runs
locally **under that same id**, so the pending battle you created in the web app is the one that
completes, and no second battle is created. `--local-only` still fetches the spec (that one request
needs the token) and then uploads nothing.

### `arena demo`

Two deterministic fake runs over a seeded project: no agent CLI, no network, no model spend. Use it
to see what a battle report looks like.

```bash
arena demo                       # prints the verdict and the report path
arena demo --json                # machine-readable
arena demo --export examples/demo  # regenerate the committed demo fixtures
```

`--export` writes `battle.json` and `events.ndjson`, rewriting every occurrence of your ARENA_HOME to
`~/.harness-arena` so the files are identical on every machine.

### `arena replay <id>` / `arena open <id>` / `arena status [id]` / `arena list`

```bash
arena list --limit 10            # newest first: id, status, winner, created, title
arena status                     # the newest battle
arena status btl_… --watch       # tail the event log until the battle finishes
arena replay btl_…               # rebuild report.html from battle.json + events.ndjson, then open it
arena open btl_…                 # just open the report
```

`arena replay` opens the report unless you pass `--no-open` or `--json`. With `--watch --json`,
`arena status` stays quiet while it tails and prints a single document when the battle finishes,
with the events it saw in `events`.

### `arena agents`

What is installed, what version, whether auth could be confirmed, and what each CLI can actually
report (`tokens/cost/turns/toolCalls reported, subagents n/a`). Arena never probes credentials: `auth
unknown` means the CLI offers no free way to check, not that something is wrong.

### `arena harnesses inspect <url|path>`

A compatibility report without executing anything. GitHub URLs are read through the REST API (no
clone); local paths are read from disk.

```
Detected multi-agent harness  example-harness
  Commit          b6a93a33c855
  Agents          claude-code, codex
  Files scanned   7

  ✓ CLAUDE.md         1 file
  ✓ Claude settings   1 file
  ✓ Hooks             1 file
  ✓ Skills            1 file
  ✓ Subagents         1 file
  ✓ AGENTS.md         1 file  read by Codex and, as a fallback, by several other CLIs
  ✓ arena.yaml        1 file
  ✗ MCP               none

  ✓ arena.yaml is valid

  No commands would run on your machine.
  Files copied into the workspace: CLAUDE.md, .claude, AGENTS.md

  Compatibility   ready
      • arena.yaml is a valid version 1 manifest (example-harness)
      • Declares 3 path(s) to apply: CLAUDE.md, .claude, AGENTS.md

✓ Ready to battle
```

`--ref <ref>` inspects a branch, tag or commit and `--agent <id>` inspects it for one agent (default
`claude-code`). `GITHUB_TOKEN` (or `GH_TOKEN`) raises the API rate limit and reaches private
repositories. `arena harnesses list` shows what is already cached under `ARENA_HOME/harnesses`.

### `arena login` / `arena logout` / `arena whoami`

Optional. Battles work completely offline; logging in only adds the web report and the leaderboard.

```bash
arena login                      # device flow; prints a code, opens the browser
arena login --server https://arena.example --no-browser
arena whoami
arena logout                     # deletes the local token and revokes the device server-side
```

The device flow prints a short code, opens the verification page, and polls until you approve it. The
token is written to `ARENA_HOME/config.json` with mode 0600 on POSIX (on Windows the file inherits
the permissions of your user profile directory) and is **never printed**; only its prefix is shown. What the token can do: create and update _your_ battles, upload events and artifacts
allowed by the privacy level, and read your own account. It has no access to any provider
credential, because Arena never holds one. `--server <url>` works on `login`, `logout` and `whoami`
(and on `battle` and `run`). Server URL resolution: `--server` > `ARENA_SERVER_URL` > `config.json` >
`http://localhost:3000`.

### `arena doctor`

```bash
arena doctor
arena doctor --fix               # remove orphaned worktrees and stale locks
```

Reports the Node and git versions, `ARENA_HOME` and whether it is writable, its size, the detected
agents, orphaned battle workspaces (a battle whose record never reached a terminal status and whose
lock belongs to a dead process) and stale locks. Every verdict carries the number of battle
directories scanned. `--fix` removes those workspaces and locks and closes each dead battle's
record as `cancelled` (runs as `interrupted`, with the reason in `error`), so `arena list` never shows a
battle as running forever. It only ever touches paths inside `ARENA_HOME`.

### `arena regression <dir>`

Run a directory of battle specs with a baseline harness on side A and a candidate on side B. This is
the CI shape: it never uploads anything.

```bash
arena regression ./battles --baseline vanilla --candidate . --agent claude-code --markdown regression.md
```

```
  Spec        Winner     Tests base  Tests cand  Time base    Time cand    Tokens base  Tokens cand  Regression
  auth.json   candidate  12/0        12/0        4.2 minutes  3.9 minutes  180400       148200       no
  cache.json  candidate  8/0         8/0         3.1 minutes  3.0 minutes  120300       99100        no

Completion +6 percent / Tokens -18 percent / Duration -4 percent / Regressions none
Completed: baseline 2/2, candidate 2/2
```

Exit code 1 when the candidate completes fewer battles than the baseline or introduces a regression
(a battle the baseline completed and the candidate did not, fewer tests passing, or more tests
failing). `--markdown <file>` writes the same table for a GitHub check.

```yaml
# .github/workflows/harness-regression.yml
name: harness regression
on: pull_request
jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm install -g harness-arena
      # Your own agent CLI and its login live on this runner; Arena never ships credentials.
      - run: arena regression ./battles --baseline origin/main --candidate . --agent claude-code --markdown regression.md --trust
      - run: cat regression.md >> "$GITHUB_STEP_SUMMARY"
        if: always()
```

### `arena clean`

```bash
arena clean                      # finished battles older than 30 days, after confirmation
arena clean --older-than 7 --yes
```

Removes finished battle directories (`completed`, `failed`, `cancelled`) from `ARENA_HOME` only.
Without a terminal it refuses to delete unless `--yes` is present.

## The competitive layer

Arena hosts no runner. A benchmark pack, a challenge, a tournament match and a bounty submission are
all definitions: the battles behind them run on your machine, with the agent CLI and subscription you
already have, and the record is uploaded afterwards. The server stores the definition, verifies that
an uploaded battle really ran the harnesses it names, links it, and labels the result community.
Nothing in this section runs on Arena hardware.

The read commands (`leaderboard`, `rating`, `profile`, `h2h`, `badge`) need no login: they read public
data. The write commands (`benchmark publish`, `challenge create`, `challenge run`, `tournament play`)
need `arena login`, and say so instead of failing with an HTTP error.

### `arena benchmark`

A benchmark pack is a reusable set of tasks, immutable by content hash: the same file always publishes
as the same `bmv_…` version id, so two people can prove they ran the same work.

```bash
arena benchmark list                                   # packs on this machine
arena benchmark list --server --category debugging     # and the ones the server holds
arena benchmark show acme-pack                         # tasks, categories, trials, version id
arena benchmark validate ./packs/acme.json             # check a file and print the version id
arena benchmark publish ./packs/acme.json              # needs `arena login`
arena benchmark run acme-pack --a . --b vanilla --agent claude-code --trials 3
```

| Command                     | Flags                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benchmark list`            | `--server [url]`, `--category <name>`, `--limit <n>`, `--json`                                                                                                                                             |
| `benchmark show <pack>`     | `--server <url>`, `--version <id>`, `--json`                                                                                                                                                               |
| `benchmark validate <file>` | `--json`                                                                                                                                                                                                   |
| `benchmark publish <file>`  | `--server <url>`, `--json`                                                                                                                                                                                 |
| `benchmark run <pack>`      | `--a <harness>` and `--b <harness>` (both required), `--agent <id>`, `--trials <n>`, `--task <id>`, `--upload <level>`, `--visibility <level>`, `--trust`, `--markdown <file>`, `--server <url>`, `--json` |

`--json` shapes: `list` gives `{ home, local, problems, server, serverError }`; `show` gives
`{ file, versionId, battles, pack }` for a local pack and the server's own document for a published
one; `validate` gives `{ valid, file, slug, version, versionId, tasks, battles, categories }`;
`publish` gives `{ created, slug, version, versionId, url, file, localVersionId }`, with
`created: false` when that exact content was already published; `run` gives
`{ pack, competitors, agent, rows, summary }`.

Exit codes: `1` for a usage error, an unreadable pack, or a publish with no login, and `1` as well
when a pack run leaves battles incomplete, because a partial pack result is not a result.

### `arena experiment` and `arena compare`

An experiment is control against treatment over the same tasks, with the statistics attached: a
regression (two commits of one harness), an ablation (one component removed), or a comparison (two
unrelated harnesses). Control is side A and treatment is side B in every battle.

```bash
# did this harness get better between two commits?
arena compare . --from v0.3.0 --to HEAD --benchmark acme-pack --trials 3

# the same thing spelled out, plus ablations and comparisons
arena experiment run --kind regression --control .@v0.3.0 --treatment .@HEAD --benchmark acme-pack
arena experiment run --kind ablation --control . --treatment . --component skill:tests-first --benchmark acme-pack
arena experiment show exp_0123456789abcdef
arena experiment list --limit 10
```

| Command                | Flags                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `experiment run`       | `--kind <kind>`, `--control <harness>`, `--treatment <harness>` (all three required), `--component <kind:name>`, `--benchmark <pack>`, `--spec-dir <dir>`, `--task <id>`, `--agent <id>`, `--trials <n>`, `--title <text>`, `--upload <level>`, `--visibility <level>`, `--trust`, `--markdown <file>`, `--server <url>`, `--json` |
| `experiment show <id>` | `--server <url>`, `--json`                                                                                                                                                                                                                                                                                                         |
| `experiment list`      | `--limit <n>`, `--json`                                                                                                                                                                                                                                                                                                            |
| `compare <harness>`    | `--from <commit>` and `--to <commit>` (both required), then the same work, agent, upload and output flags as `experiment run`                                                                                                                                                                                                      |

`--control` and `--treatment` accept `harness@commit`. An ablation must name the one thing that
differs (`--component <kind>:<name>`), because an experiment with two changes measures neither.
`--benchmark` and `--spec-dir` are mutually exclusive, and one of them is required.

`experiment run --json` gives `{ id, title, kind, control, treatment, battles, summary, file, url }`.
The summary carries its own sample: battles, comparable battles, per-side correctness rates with their
denominators, token, cost and duration deltas, per-category rows, an evidence strength, and
conclusions that each name the number of battles behind them.

Exit codes: `1` for a usage error, and `1` when no battle reached a verdict, because an experiment
that measured nothing must not read as a green result.

### `arena challenge`

A challenge is a published definition: two harnesses, one agent, one piece of work. Creating one runs
nothing. Whoever accepts it runs it on their own machine and uploads the battle.

```bash
arena challenge create --a . --b vanilla --agent claude-code --task ./task.md --repo https://github.com/owner/project
arena challenge create --a . --b vanilla --agent codex --benchmark acme-pack@bmv_0123456789abcdef01234567
arena challenge list --status open --harness superclaude
arena challenge show chl_0123456789abcdef
arena challenge run chl_0123456789abcdef --trust      # runs HERE, then uploads
```

| Command               | Flags                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `challenge create`    | `--a <harness>`, `--b <harness>`, `--agent <id>` (all three required), `--benchmark <slug@versionId>`, `--task <file>`, `--repo <url or path>`, `--title <text>`, `--visibility <level>`, `--upload <level>`, `--no-rating`, `--server <url>`, `--json` |
| `challenge list`      | `--status <status>`, `--harness <slug>`, `--limit <n>`, `--server <url>`, `--json`                                                                                                                                                                      |
| `challenge show <id>` | `--server <url>`, `--json`                                                                                                                                                                                                                              |
| `challenge run <id>`  | `--trust`, `--upload <level>`, `--server <url>`, `--json`                                                                                                                                                                                               |

Give the work as `--benchmark <slug>@<versionId>` or as `--task <file>` together with
`--repo <url|path>`. `--no-rating` publishes a challenge whose result must not move community
ratings; eligibility is never a promise the other way, because the integrity checks in
[RATINGS.md](RATINGS.md) still decide. A challenge whose privacy level is `none` uploads nothing and
therefore completes nothing, and `arena challenge run` warns when that is the case.

`--json` shapes: `create` gives `{ id, url, status, note }`; `list` gives `{ challenges, count, note }`;
`show` gives `{ challenge, url, note }`; `run` gives `{ challengeId, url, battles, note }` with each
battle as `{ id, status, winner, url }`. `note` is the same sentence on every response: Arena hosts no
runner.

Exit codes: `1` for a usage error, a missing login on `create` or `run`, a challenge that is cancelled
or expired, or a server that refuses. A battle that fails during `challenge run` exits `2`, like any
other battle.

### `arena tournament`

A single-elimination bracket over the same work. Arena settles matches from uploaded battles and plays
none of them.

```bash
arena tournament show autumn-cup             # bracket, seeds, how each match settled
arena tournament play autumn-cup --trust     # run every pending match on this machine
```

| Command                        | Flags                                                     |
| ------------------------------ | --------------------------------------------------------- |
| `tournament show <id-or-slug>` | `--server <url>`, `--json`                                |
| `tournament play <id-or-slug>` | `--trust`, `--upload <level>`, `--server <url>`, `--json` |

`show --json` gives `{ tournament, url, pending, note }`; `play --json` gives
`{ tournament, url, played, remaining, stopped, note }`. A match with one entrant and no opponent is a
bye, and a tie is settled by the higher seed: both are reported as `settledBy`, never hidden. `play`
uploads, so it needs a login.

### `arena leaderboard`

Ranked harnesses for one category and one pool, read from the server. No login needed.

```bash
arena leaderboard
arena leaderboard --category debugging --agent claude-code --limit 20
arena leaderboard --pool verified
```

```
Overall - Community pool

  Rank  Harness      Agent        Rating    Peak  Battles  W/L/T   Form   Sample
  1     superclaude  claude-code  1624 ±74  1650  24       14/7/3  WWLTW  24/10
  2     tidy-agent   claude-code  1512 ±96  1540  18       9/7/2   LWWTW  18/10

-- provisional: fewer than 10 decided battles, or a deviation too wide to order. Listed, never ranked. --
  -  fresh-harness  claude-code  1500 ±320  1500  3  2/1/0  WWL  3/10

Community ratings come from battles contributors ran on their own machines and uploaded. Arena executed none of them.
```

Flags: `--category <name>`, `--pool community|verified`, `--agent <id>`, `--limit <n>`,
`--server <url>`, `--json`. The rating column is always `rating ±deviation`, the Sample column is
always the decided battles over the minimum needed for a rank, and provisional rows are never mixed
into the ranked ones. `--pool verified` prints the honest line the server sends when the pool holds
nothing at all: Arena hosts no runner, so no battle has been executed under verified conditions.

`--json` gives `{ server, category, pool, agentId, minSample, poolEmpty, ranked, provisional, entries, note }`.

### `arena rating <slug>`

One harness rating, and with `--history` the audit trail behind it.

```bash
arena rating superclaude
arena rating superclaude --agent claude-code --category debugging --history
```

Flags: `--agent <id>`, `--category <name>`, `--pool community|verified` (default `community`),
`--history`, `--server <url>`, `--json`. Prints the current rating with its deviation, the peak, the
battle count, the win/loss/tie record, the win and tie rates with their denominators, recent form and
the last battle; a provisional rating says so. `--history` adds one row per rating event: battle id,
date, opponent, outcome, and the rating before and after. Those rows are `rating_events` straight from
the database and are never edited, so the number can be recomputed by hand.

`--json` gives `{ server, slug, name, category, pool, ratings, history, note }`, with `history` present
only when `--history` was passed.

### `arena profile <slug>`

Everything the server holds about one harness: identity and source, every (agent, category, pool)
rating, per-category performance with its correctness sample, the median token, cost and duration
ratios against its opponents, the commits that have been tested, who it has fought, the insights with
the sample each rests on, and declared lineage. Flags: `--server <url>`, `--json`. An unmeasured ratio
prints `n/a`, never `0`.

### `arena h2h <slug> <other>`

The record between two harnesses, under the filters that produced it.

```bash
arena h2h superclaude vanilla --agent claude-code --category debugging --since 2026-08-01
```

Flags: `--agent <id>`, `--category <name>`, `--pool community|verified`, `--benchmark <slug>`,
`--commit <sha>` (battles where the first harness ran this commit; a prefix is enough),
`--since <date>`, `--until <date>`, `--server <url>`, `--json`. Prints wins, losses, ties,
inconclusive battles, the win rate over the decided ones, the last battle and the most recent battle
ids.

### `arena badge <slug>`

The badge URL and the Markdown snippet for a harness README. This command makes no request: it builds
URLs, so it works offline.

```bash
arena badge superclaude
arena badge superclaude --kind win-rate --category debugging --markdown
```

Flags: `--kind rating|verified-rating|win-rate|correctness|battles|tokens|top` (default `rating`),
`--category <name>`, `--agent <id>`, `--markdown` (print only the snippet), `--server <url>`,
`--json`. Every badge states its sample or reads provisional, and `verified-rating` reads "no verified
battles" while no hosted runner exists.

```markdown
[![Community rating](https://arena.example/api/v1/badges/superclaude/rating)](https://arena.example/harnesses/superclaude)
```

## `battle.json` reference

Every field of `battleSpecSchema` (`packages/protocol/src/battle.ts`). Only `version`, `task`,
`repository` and `competitors` are required.

```json
{
  "version": 1,
  "title": "Example harness vs vanilla Claude Code on a GitHub issue",
  "task": { "kind": "issue", "repo": "owner/project", "number": 137 },
  "repository": { "source": "https://github.com/owner/project", "ref": "main", "submodules": false },
  "competitors": {
    "a": {
      "label": "Example harness",
      "agent": { "id": "claude-code", "model": "sonnet", "args": [], "env": {} },
      "harness": { "source": "./examples/example-harness", "trusted": true }
    },
    "b": {
      "label": "Vanilla Claude Code",
      "agent": { "id": "claude-code", "model": "sonnet" },
      "harness": { "source": "vanilla" }
    }
  },
  "limits": { "timeoutMs": 1200000, "maxTurns": 60, "maxBudgetUsd": 5 },
  "evaluation": {
    "tests": { "command": "npm test", "baseline": true, "parser": "auto", "timeoutMs": 600000 },
    "build": ["npm run build"],
    "lint": ["npm run lint"],
    "typecheck": ["npx tsc --noEmit"],
    "assertions": [
      { "type": "file-contains", "path": "src/auth/session.js", "pattern": "1000" },
      { "type": "diff-not-touches", "paths": ["package-lock.json"] }
    ],
    "judge": { "enabled": false }
  },
  "privacy": { "upload": "metrics", "exclude": ["diffs", "file_contents"], "redact": true },
  "mode": "local",
  "visibility": "private",
  "parallel": false,
  "tags": ["auth"],
  "category": "debugging"
}
```

| Field                                     | Meaning                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                 | always `1`                                                                                                                              |
| `title`                                   | shown in reports and lists; defaults to the task title                                                                                  |
| `task.kind`                               | `prompt` (with `prompt`, optional `title`) or `issue` (with `repo`, `number`, optional `instructions`)                                  |
| `repository.source`                       | GitHub URL, git URL, local path, or `empty` for a greenfield task                                                                       |
| `repository.ref`                          | branch, tag or commit; the exact commit is resolved once and used by both sides                                                         |
| `repository.subdir`                       | run the agent in a subdirectory of the repository                                                                                       |
| `repository.submodules`                   | check out submodules in each workspace (default `false`)                                                                                |
| `competitors.a/b.label`                   | display name for the side                                                                                                               |
| `competitors.a/b.agent.id`                | `claude-code`, `codex`, `gemini-cli`, `opencode`, `fake`                                                                                |
| `competitors.a/b.agent.model`             | passed to the CLI as-is                                                                                                                 |
| `competitors.a/b.agent.args`              | extra CLI arguments, verbatim, never shell-interpolated                                                                                 |
| `competitors.a/b.agent.env`               | extra environment variables for that agent process; values are redacted from telemetry                                                  |
| `competitors.a/b.harness.source`          | `vanilla`, a GitHub/git URL, or a local path                                                                                            |
| `competitors.a/b.harness.ref` / `.commit` | pin the harness                                                                                                                         |
| `competitors.a/b.harness.manifestPath`    | non-default location of `arena.yaml`                                                                                                    |
| `competitors.a/b.harness.trusted`         | you approve the commands this harness declares                                                                                          |
| `competitors.a/b.fixture`                 | fake adapter only: which recorded fixture to replay                                                                                     |
| `limits.timeoutMs`                        | per side (default 20 minutes)                                                                                                           |
| `limits.maxTurns`, `limits.maxBudgetUsd`  | stop a side early; enforced only where the CLI reports the number                                                                       |
| `limits.maxOutputBytes`                   | cap on captured stdout+stderr per run (default 50 MB)                                                                                   |
| `evaluation.tests`                        | command, whether to run a baseline first, parser (`auto`, `vitest`, `jest`, `pytest`, `go`, `cargo`, `tap`, `exit-code`), timeout       |
| `evaluation.build` / `lint` / `typecheck` | commands that must succeed; each is reported separately                                                                                 |
| `evaluation.assertions`                   | `file-exists`, `file-missing`, `file-contains`, `file-not-contains`, `command`, `diff-touches`, `diff-not-touches`, `max-files-changed` |
| `evaluation.judge`                        | optional blind LLM judge; always labelled subjective and never decisive on its own                                                      |
| `privacy.upload`                          | `none` (default), `metrics`, `events`, `full`                                                                                           |
| `privacy.exclude`                         | `prompts`, `model_outputs`, `command_output`, `file_contents`, `diffs`, `paths`                                                         |
| `privacy.redact`                          | run the secret redactor over events and artifacts (default `true`, always on for uploads)                                               |
| `mode`                                    | `local` (your subscription), `local-byok` (your API keys), `cloud` (designed, not hosted)                                               |
| `visibility`                              | `private`, `unlisted`, `public`                                                                                                         |
| `parallel`                                | run both sides at once                                                                                                                  |
| `tags`, `category`                        | metadata; `category` groups ratings (`debugging`, `refactoring`, `greenfield`, …)                                                       |

## Local-only mode

`--local-only` (or simply never running `arena login`) keeps everything under
`ARENA_HOME/battles/<id>/`: `battle.json`, `events.ndjson`, `runs/<side>/` (raw provider log and
patch), `report.html`. Arena itself makes no network request in this mode, with one exception:
`arena run --battle <id>` fetches that battle's spec from the server before it starts, and uploads
nothing afterwards. Your agent CLI still talks to its own provider exactly as it always does.

## Privacy flags

`--upload` chooses how much a connected battle sends; `--exclude` removes categories on top of it.
Both map straight to `privacy.upload` and `privacy.exclude` in `battle.json`. The full table lives in
[Privacy](/docs/privacy). Redaction runs locally before anything is written to disk or uploaded, so
an event log never contains a token you had in your environment.

## Troubleshooting

**"… was not found on PATH"** — install the official CLI and sign in with your own account, then run
`arena agents`. Arena never installs an agent CLI for you and never touches its credentials.

**`auth unknown`** — expected. Claude Code, Codex, Gemini CLI and OpenCode offer no free way to check
a session, and Arena refuses to spend a request or read a credential file to find out. The first run
tells you: an ineligible or logged-out account fails fast with the CLI's own error.

**Usage limits** — when your subscription hits its limit mid-battle, the CLI says so, Arena records a
`limit.hit` event and marks that run `failed`/`interrupted` with the provider's message. The battle
record, the event log and the report are still written. Re-run when the limit resets; nothing is
retried silently.

**A battle hangs** — `Ctrl+C` once aborts it: the process tree is killed, the record is saved and the
report is written, so `arena status` and `arena replay` still work. `Ctrl+C` twice exits immediately.

**Leftovers after a crash** — `arena doctor` lists orphaned workspaces and stale locks, `arena doctor
--fix` removes them and closes the dead battles as cancelled. `arena clean --older-than 30` reclaims space from old battles.

**GitHub rate limits while inspecting a harness** — set `GITHUB_TOKEN`; the message says so and names
the reset time when GitHub reports one.

**Windows notes** — everything above works in PowerShell and in cmd. Line endings, `.cmd` shims and
`PATHEXT` are handled: the npm-installed `claude.cmd` is found the same way `claude` is on Linux.
Box-drawing characters and check marks fall back to ASCII outside Windows Terminal and VS Code. Paths
with spaces are safe: Arena builds argument arrays and never a shell string. `ARENA_HOME` defaults to
`C:\Users\<you>\.harness-arena`; pass `--home` to put it somewhere else (a short path helps if a
harness creates deep node_modules trees).
