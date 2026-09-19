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
assertions, build checks. If everything is equal it returns `tie`; if no deterministic evaluator ran at
all it returns `inconclusive` and says what to configure. Efficiency (duration, tokens, cost) never
picks a winner: it is reported as a caveat. A judge opinion never overrides deterministic evidence.

## Test output parsing

`parseTestOutput(output, parser)` reads vitest, jest, pytest, `go test`, `cargo test` and TAP
(`node --test --test-reporter=tap`) output, plus `exit-code` (no counts at all) and `auto` (try each,
fall back to `exit-code`). Counts stay `null` when the tool did not report them; the UI shows "n/a",
never `0`.

## Why test commands run through a shell

`evaluation.tests.command`, the build/lint/typecheck commands and `command` assertions are single
user-authored shell lines (`npm test -- --run`, `pytest -q && echo done`). They are executed as
`cmd.exe /d /s /c <line>` on Windows and `sh -c <line>` elsewhere, with the line passed as one argument
and nothing interpolated into it by Arena. Agent CLIs are never started this way: adapters build a fixed
argv and pass the prompt over stdin.

## Local development

```
pnpm exec tsc -p packages/evaluator/tsconfig.json --noEmit
pnpm exec vitest run packages/evaluator
pnpm exec eslint packages/evaluator
```
