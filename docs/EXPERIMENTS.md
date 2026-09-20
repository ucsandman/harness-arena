# Experiments

An experiment answers one question: **did this change make the harness better?** Control runs as
side A, treatment runs as side B, both get the same tasks, and the result is a set of paired
observations with the arithmetic attached — not a vibe.

```bash
arena experiment run \
  --kind regression \
  --control https://github.com/you/harness@a1b2c3d \
  --treatment https://github.com/you/harness@e4f5a6b \
  --benchmark arena-smoke \
  --trials 3

# sugar for exactly the above:
arena compare https://github.com/you/harness --from a1b2c3d --to e4f5a6b --benchmark arena-smoke
```

Arena runs nothing for you: these battles execute on your machine with your agent CLIs. The summary
is computed locally from the records the run just produced, so an experiment is complete offline. An
upload only adds a page other people can read; the server recomputes the same numbers with the same
function.

## The three kinds

| Kind         | Control                           | Treatment           | Question                           |
| ------------ | --------------------------------- | ------------------- | ---------------------------------- |
| `regression` | the previous commit of a harness  | the current commit  | did my change help or hurt?        |
| `ablation`   | the harness without one component | the harness with it | is this component worth keeping?   |
| `comparison` | one harness                       | a different harness | which of these two is better here? |

An ablation must name the one thing that differs: `--component skill:code-review`. That is what lets
the component catalogue say "this skill has evidence behind it" instead of "someone liked it". Kinds
of component: `harness`, `instructions`, `skill`, `hook`, `mcp`, `subagent`, `prompt`, `settings`,
`memory`, `benchmark`.

## Flags

| Flag                             | What it does                                                         |
| -------------------------------- | -------------------------------------------------------------------- |
| `--kind <kind>`                  | `regression`, `ablation` or `comparison` (required)                  |
| `--control <harness[@commit]>`   | side A (required)                                                    |
| `--treatment <harness[@commit]>` | side B (required)                                                    |
| `--benchmark <file-or-slug>`     | the pack to run                                                      |
| `--spec-dir <dir>`               | a directory of `*.json` battle specs instead of a pack (stays local) |
| `--task <id>`                    | one task of the pack                                                 |
| `--agent <id>`                   | agent CLI for both sides (default `claude-code`)                     |
| `--trials <n>`                   | runs per task                                                        |
| `--component <kind>:<name>`      | the one component that changed (required for an ablation)            |
| `--title <text>`                 | title for the experiment                                             |
| `--upload <level>`               | `none` (default), `metrics`, `events`, `full`                        |
| `--trust`                        | approve harness install/prepare commands without asking              |
| `--markdown <file>`              | write the summary as Markdown                                        |
| `--json`, `--home <dir>`         | as everywhere else in the CLI                                        |

Every run writes `ARENA_HOME/experiments/<id>.json`: the control and treatment, the pack version, one
row per battle, and the summary. `arena experiment list` shows them, `arena experiment show <id>`
prints one back (from disk when this machine ran it, from the server otherwise).

## How the summary is computed

Every number below comes from one pure function over the battle records
(`computeExperimentSummary`), so the CLI, the MCP server and the web app cannot disagree.

**Correctness.** A side is _correct_ on a battle when it passed every correctness gate that actually
ran. The gates are the verdict's own stages: `completion`, `tests`, `regressions`, `assertions`,
`build`. A stage whose result names the other side means this side failed that gate; a stage that
could not run (`n/a`) proves nothing and is ignored; a battle where no gate ran at all is left out of
the correctness sample entirely. The rate carries a Wilson interval, which stays honest on small
samples instead of collapsing to a point.

Efficiency is deliberately not part of correctness. Spending fewer tokens on a wrong answer is not an
improvement; efficiency only breaks a tie between equally correct sides (see [VERDICTS.md](VERDICTS.md)).

**Comparable battles.** A battle is _comparable_ when both sides completed their run, so their
metrics describe the same work. `battles` counts everything that reached a verdict; `comparable` is
the number the metric deltas are computed over, and the two are printed side by side so a summary can
never quietly average over battles where one side crashed.

**Tokens, cost, duration.** Paired per battle: a battle contributes only when _both_ sides report a
numeric value that the adapter observed or calculated. Estimated values (a cost derived from list
prices because the CLI reported none) and unavailable ones are excluded — an estimate compared with
an observation is not a measurement. `deltaPercent` is `(treatment mean − control mean) / control
mean`.

**By category.** Battles are bucketed by the task's category (an unrecognised one falls into
`overall`), so "better at debugging, worse at refactoring" is visible instead of averaged away.

**Evidence.** The level is a function of the comparable battle count, and it names its own sample:

| Comparable battles | Level    | What it means                                        |
| ------------------ | -------- | ---------------------------------------------------- |
| 0–4                | `none`   | below the minimum for even a weak conclusion         |
| 5–9                | `low`    | enough to describe this pair, not to generalise      |
| 10–29              | `medium` | enough to see a direction, not a precise effect size |
| 30+                | `high`   | enough to state an effect size                       |

## How to read the conclusions

The conclusions are plain sentences generated from the numbers, and each one names its sample:

- _"Treatment improved correctness from 74% to 88% (+14 points over 12 battle(s) with a correctness gate)."_
- _"Treatment used 31% more tokens without improving correctness (14 comparable battles)."_
- _"Wins: treatment 9, control 3, ties 2, inconclusive 0 over 14 decided battle(s)."_

Read the sample first and the direction second. A 40-point swing over 3 battles is noise wearing a
percentage sign; a 6-point swing over 40 battles is a result.

## One run proves nothing

This is the part it is tempting to skip. A single battle compares two samples from two stochastic
processes, on one task, on one machine, at one moment. It tells you what happened; it does not tell
you what will happen next time.

What that means in practice:

- One trial on one task is an anecdote. Use `--trials` and a pack with several tasks.
- An experiment labelled `none` or `low` is a reason to run more battles, not a headline.
- Both sides ran on your machine, with your network and your model access. A slower side may have
  been unlucky with an API, not worse.
- The same harness run twice will not produce identical numbers. That variance is exactly what the
  intervals in the summary are for.
- Ratings move only on public, completed, non-demo battles that pass the integrity checks; an
  experiment is evidence, not a score.

If a summary makes you want to post a screenshot, check `comparable` and `evidence.level` first.

## Uploading

With `--upload metrics|events|full` and an `arena login`, the run creates the experiment on the
server before the first battle, links every uploaded battle to it (the server re-checks that the
battle really ran the control and the treatment it names; a mismatched battle is refused), and
finalizes it at the end. Nothing is uploaded by default, and a `--spec-dir` experiment has no
publishable target, so it stays on your machine.

## MCP

`arena_run_experiment` and `arena_compare_versions` run the same work from an MCP client, one battle
at a time; `arena_get_experiment` reads back a record this machine wrote. The MCP tools return the
battle rows and the saved record — `arena experiment show <id>` prints the computed summary.

## Related

- [BENCHMARKS.md](BENCHMARKS.md) — the packs an experiment runs.
- [VERDICTS.md](VERDICTS.md) — how one battle is decided, and why efficiency only breaks ties.
- [CLI.md](CLI.md) — `arena regression`, the single-purpose CI check this generalises.
