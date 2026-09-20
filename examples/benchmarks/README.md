# Benchmark packs

A benchmark pack is a reusable, versioned set of tasks two harnesses can be run against. A pack is a
plain YAML (or JSON) file; `arena benchmark run` expands it into one battle per task per trial and
runs those battles on your machine, with your agent CLIs and your subscriptions.

```
examples/benchmarks/
  arena-smoke/pack.yaml     three deterministic tasks, no network and no model spend
```

Run the smoke pack:

```bash
arena benchmark validate examples/benchmarks/arena-smoke/pack.yaml
arena benchmark run examples/benchmarks/arena-smoke/pack.yaml --a vanilla --b vanilla --agent fake
```

## Format

```yaml
benchmark: 1 # pack format version
slug: my-pack # lowercase, digits and dashes; the first publisher owns it
name: My pack
version: '1.0.0' # human label; the real identity is the content hash below
description: What this pack measures.
author: your-github-login
license: MIT
visibility: public # public | unlisted | private
tasks:
  - id: fix-null-deref # stable within the pack
    title: Fix the null dereference
    category: debugging # see "Categories"
    tags: [node, typescript]
    trials: 1 # how many times this task runs per side
    task:
      kind: prompt # or kind: issue with repo + number
      prompt: The failing test in src/parse.test.ts ...
    repository:
      source: https://github.com/owner/repo
      ref: main
      commit: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b # see "Pinning a commit"
    evaluation:
      tests:
        command: npm test
        baseline: true # run before the agent, so pre-existing failures are not regressions
      assertions:
        - type: file-contains
          path: src/parse.ts
          pattern: '\\?\\.'
    limits:
      timeoutMs: 1200000
```

A pack never names the competitors: who runs it, with which agent and which harnesses, is decided at
run time. That is what makes one pack version comparable across people.

## Versioning by content hash

Every pack version is identified by `bmv_` plus the first 24 hex characters of the sha256 of its
canonical JSON (keys sorted at every level, no whitespace). Consequences:

- reformatting a file, reordering keys or changing a comment does **not** change the version id;
- editing a task, a prompt, an assertion or a repository commit **does**, and that is a new version;
- a battle records `{slug, versionId, version, taskId, trial}`, so a stored result can never point at
  a definition that changed afterwards.

`arena benchmark validate <file>` prints the version id. Publishing the same content twice is a
no-op; publishing changed content adds a version and moves the pack's "latest".

## Categories

A task's `category` is one of the Arena rating categories (`TASK_CATEGORIES` in
`@harness-arena/protocol`):

`debugging`, `refactoring`, `greenfield`, `frontend`, `backend`, `testing`, `security`,
`repo_navigation`, `long_horizon`, `performance`, `documentation`, `dependencies`.

Every task also counts towards `overall`. Pick the category the task actually measures; a pack whose
tasks are all `overall` teaches a leaderboard nothing.

## Trials

`trials` is how many times a task runs per side in one pack run. One trial of one task proves
nothing: agents are non-deterministic, and a single win is noise. Three to five trials on a handful
of tasks is the smallest sample worth reporting, and `arena experiment run` labels its evidence
strength by the number of comparable battles it actually got.

`arena benchmark run --trials <n>` replaces the per-task trial count for that run, so a pack author
can ship `trials: 1` and a user can ask for five without editing the pack.

## Pinning a commit

A ranked result must be reproducible, so a task should name an exact `commit`, not just a `ref`:

```bash
git ls-remote https://github.com/owner/repo refs/heads/main
```

Put the full 40-character sha in `repository.commit`. A pack that only names a branch still runs, but
the work changes under it as the branch moves, and results from different days are not comparable.

## Publishing

```bash
arena login
arena benchmark publish examples/benchmarks/arena-smoke/pack.yaml
```

The first account to publish a slug owns it; nobody else can publish under that slug. Versions are
immutable, so publishing is always additive. Private packs are visible only to their owner.

Full documentation: [docs/BENCHMARKS.md](../../docs/BENCHMARKS.md).
