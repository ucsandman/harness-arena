# @harness-arena/evaluator

Deterministic evaluation plugins and the verdict engine for Harness Arena.

Nothing in this package spawns an agent CLI or spends model credits. Test commands and build checks run
through an injected `ProcessRunner`; the optional LLM judge runs through a `JudgeRunner` that the caller
(core/cli) backs with the user's own authenticated CLI.

## What it does

| Evaluator      | Kind          | Decides the winner? | What it measures                                                             |
| -------------- | ------------- | ------------------- | ---------------------------------------------------------------------------- |
| `repo-tests`   | deterministic | yes                 | `evaluation.tests.command` per side, with counts, failing names, regressions |
| `build-checks` | deterministic | yes                 | every `evaluation.build` / `lint` / `typecheck` command                      |
| `assertions`   | deterministic | yes                 | the task author's assertions against the workspace and the diff              |
| `diff-signals` | deterministic | no, by design       | files/lines changed, tests touched or deleted, lockfiles, TODOs, debug logs  |
| `judge`        | subjective    | never               | a blind LLM opinion with randomized labels, always labeled subjective        |

`evaluateBattle(ctx)` runs the applicable evaluators sequentially (they share the CPU with each other,
and overlapping them would distort the durations they measure), catches per-evaluator failures into
`error` results, and pairs every protocol metric through `compareMetrics`.

`decideVerdict(report, sides)` applies fixed rules in order: completion, repository tests, regressions,
assertions, build checks. Correctness is a gate: a fast, cheap, broken run never beats a correct one.
When both sides are equally correct, efficiency breaks the tie with a weighted relative advantage over the
metrics both sides reported (tokens 40%, cost 35%, wall time 25%; estimated values excluded), and only when
that advantage is at least 5%, so timing noise never decides a battle. Below that it returns `tie`; if no
deterministic evaluator ran at all it returns `inconclusive` and says what to configure. Raw test count is
never rewarded (nine passing tests do not beat four passing tests); if added coverage matters, make it a
task assertion. Every verdict carries a `breakdown` row per stage (`a`, `b`, `tie` or `n/a`). A judge
opinion never overrides any of it.

## Test output parsing

`parseTestOutput(output, parser)` reads vitest, jest, pytest, `go test`, `cargo test` and TAP
(`node --test --test-reporter=tap`) output, plus `exit-code` (no counts at all) and `auto` (try each,
fall back to `exit-code`). Counts stay `null` when the tool did not report them; the UI shows "n/a",
never `0`.

## Why test commands run through a shell

`evaluation.tests.command`, the build/lint/typecheck commands and `command` assertions are single
user-authored shell lines (`npm test -- --run`, `pytest -q && echo done`). The invocation comes from
`shellInvocation()` in `@harness-arena/adapters`, so this package and the harness runner quote
identically: `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments` on Windows (without it Node
re-escapes the line and a command containing a double quote — `node -e "..."`, `jest -t "name"` — runs
something else and can still exit 0), and `/bin/sh -c <line>` elsewhere. Arena interpolates nothing into
the line. Agent CLIs are never started this way: adapters build a fixed argv and pass the prompt over
stdin.

## Who runs the tests

`repo-tests` prefers the outcome the engine already measured: when `SideContext.postTests` is set the
evaluator reuses it (no second suite execution, no duplicate `test.completed` event, since the engine
already emitted one) and only runs `evaluation.tests.command` itself when `postTests` is `null`.

## Local development

```
pnpm exec tsc -p packages/evaluator/tsconfig.json --noEmit
pnpm exec vitest run packages/evaluator
pnpm exec eslint packages/evaluator
```
