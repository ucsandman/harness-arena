# Benchmark packs

A benchmark pack is a reusable, versioned set of tasks that two harnesses can be run against. One
pack version is one fixed body of work, so two people on two machines run exactly the same thing and
their results can be put beside each other.

Arena hosts no runner. `arena benchmark run` expands a pack into ordinary battles and runs them on
your machine with your agent CLIs and your subscriptions. The server is a catalogue: it stores pack
definitions and links uploaded battles, and every result it shows is community-reported.

## The file

A pack is YAML or JSON. The committed example is
[`examples/benchmarks/arena-smoke/pack.yaml`](../examples/benchmarks/arena-smoke/pack.yaml).

```yaml
benchmark: 1 # pack format version
slug: my-pack # lowercase letters, digits, dashes; globally unique; first publisher owns it
name: My pack
version: '1.0.0' # human label; the identity is the content hash, not this
description: What this pack measures.
author: your-github-login
license: MIT
visibility: public # public | unlisted | private
tasks:
  - id: fix-null-deref # stable within the pack; battles record it
    title: Fix the null dereference
    description: Optional longer context for a reader.
    category: debugging
    tags: [node, typescript]
    trials: 1
    task:
      kind: prompt # or: kind: issue, repo: owner/name, number: 137
      prompt: |
        The test in src/parse.test.ts fails on empty input. Fix it without changing the public API.
    repository:
      source: https://github.com/owner/repo
      ref: main
      commit: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b
      subdir: packages/parser # optional
    evaluation:
      tests:
        command: npm test
        baseline: true # run before the agent, so pre-existing failures are not counted as regressions
        parser: auto
      build: ['npm run build']
      assertions:
        - type: file-contains
          path: src/parse.ts
          pattern: '\?\.'
          label: the fix uses optional chaining
        - type: diff-not-touches
          paths: ['package.json']
    limits:
      timeoutMs: 1200000
      maxTurns: 60
```

`task`, `repository`, `evaluation` and `limits` are exactly the battle-spec blocks documented in
[CLI.md](CLI.md); a pack is a list of battles with the competitors left out. Who runs a pack, with
which agent and which harnesses, is decided at run time — that is what makes one pack version
comparable across people.

## Versioning: the content hash is the identity

Every pack version is `bmv_` plus the first 24 hex characters of the sha256 of its canonical JSON
(keys sorted at every level, no whitespace, `undefined` dropped).

- Reformatting, reordering keys or editing a comment does **not** change the version id.
- Editing a prompt, an assertion, a commit or a trial count **does** — that is a new version.
- A battle produced from a pack records `{ slug, versionId, version, taskId, trial }`, so a stored
  result can never point at a definition that changed afterwards.
- Publishing the same content twice is a no-op. Versions are immutable and only ever accumulate.

```bash
arena benchmark validate examples/benchmarks/arena-smoke/pack.yaml
# ✓ arena-smoke is a valid benchmark pack
#   Version id      bmv_3723b68420f0d0649c862dff
```

## Categories

`category` is one of the Arena rating categories (`TASK_CATEGORIES` in `@harness-arena/protocol`):

`debugging`, `refactoring`, `greenfield`, `frontend`, `backend`, `testing`, `security`,
`repo_navigation`, `long_horizon`, `performance`, `documentation`, `dependencies`.

Every task also counts towards `overall`. Pick the one the task actually measures: category
leaderboards are only as meaningful as the labels underneath them.

## Trials

`trials` is how many times each task runs per side in one pack run. Agents are not deterministic, so
one trial of one task is an anecdote. `--trials <n>` replaces the pack's own count for that run, so a
pack can ship `trials: 1` and a user can ask for five without editing (and re-hashing) the pack.

The battles one full run produces is the sum of the trials over the tasks; `arena benchmark list`
shows it as the `Battles` column, so you know what you are about to spend before you start.

## Pinning a commit

A ranked result must be reproducible, so a task should name an exact commit:

```bash
git ls-remote https://github.com/owner/repo refs/heads/main
```

Put the full 40-character sha in `repository.commit`. A pack that names only a branch still runs, but
the work changes under it as the branch moves, and two runs from different days are not comparable.

## The commands

```bash
arena benchmark list                     # packs in ./examples/benchmarks and ARENA_HOME/benchmarks
arena benchmark list --server            # and the ones the server holds (needs arena login)
arena benchmark show arena-smoke         # tasks, categories, trials, version id
arena benchmark validate ./pack.yaml     # parse it and print the version id it would publish as
arena benchmark publish ./pack.yaml      # publish a version (needs arena login)

arena benchmark run arena-smoke \
  --a vanilla \
  --b https://github.com/you/your-harness \
  --agent claude-code \
  --trials 3
```

`arena benchmark run` flags:

| Flag                              | What it does                                                 |
| --------------------------------- | ------------------------------------------------------------ |
| `--a <harness>` / `--b <harness>` | required; `vanilla`, a GitHub URL, or a local path           |
| `--agent <id>`                    | agent CLI for both sides (default `claude-code`)             |
| `--trials <n>`                    | runs per task, replacing the pack's own count                |
| `--task <id>`                     | run one task instead of the whole pack                       |
| `--upload <level>`                | `none` (default), `metrics`, `events`, `full`                |
| `--visibility <level>`            | `private`, `unlisted`, `public` for the uploaded battles     |
| `--trust`                         | approve harness install/prepare commands without asking      |
| `--markdown <file>`               | write the table as Markdown, for a CI check                  |
| `--json`                          | machine-readable result on stdout (human lines go to stderr) |
| `--home <dir>`                    | use this directory instead of `ARENA_HOME`                   |

It prints one row per task and trial (winner, whether each side passed the correctness gates, tokens
and wall-clock time), then wins, correctness and medians. It exits 0 when every battle completed and
1 when any did not, so it can be a CI gate.

Every battle is a normal battle: it lands in `ARENA_HOME/battles/<id>` with its own report, and
`arena open <id>` shows it.

## Publishing

```bash
arena login
arena benchmark publish examples/benchmarks/arena-smoke/pack.yaml
```

The first account to publish a slug owns it; another account publishing to that slug is refused.
Publishing is always additive: a changed pack adds a version and moves the pack's "latest". Private
packs are visible only to their owner.

## MCP

The same surface is available to an MCP client: `arena_list_benchmarks` lists the packs this machine
can see, and `arena_run_benchmark` runs one, a single battle at a time, refusing to start a second
while one is running. See [ARCHITECTURE.md](ARCHITECTURE.md) for the MCP server.

## What a pack result does and does not prove

A pack run is a sample, not a ranking. A pack with three tasks and one trial is three battles; the
[experiments](EXPERIMENTS.md) page explains how many comparable battles a claim actually needs and
how the evidence level is derived. Ratings only move for public, completed, non-demo battles that
pass the integrity checks.
