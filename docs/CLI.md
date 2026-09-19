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
