# Verdicts

How a battle gets a winner. Everything on this page is computed by `decideVerdict` in
`packages/evaluator/src/verdict.ts` from the evaluation report; nothing is weighted by an LLM, and the
optional blind judge can never set the winner.

## The hierarchy

Stages are consulted in this order. The first stage that separates the two sides decides the battle
and every later stage is reported as not consulted.

| #   | Stage        | Decides when                                                                                                                                   | Confidence |
| --- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Completion   | one side completed and the other timed out, failed, or was interrupted                                                                         | 0.90       |
| 2   | Tests        | both suites ran with counts; one side passed everything, the other has failures (or, with the `exit-code` parser, one exit 0 and one non-zero) | 0.80       |
| 3   | Regressions  | both sides report regression counts; one introduced regressions, the other none                                                                | 0.90       |
| 4   | Assertions   | both sides ran the task assertions and satisfied a different number                                                                            | 0.70       |
| 5   | Build checks | both sides ran build/lint/typecheck and only one passed everything                                                                             | 0.60       |
| 6   | Efficiency   | every stage above tied on evidence both sides produced; see below                                                                              | 0.55       |
| 7   | Inconclusive | no deterministic evaluator produced a result for both sides                                                                                    | 0.10       |

A fast broken solution never beats a correct one: efficiency is reached only after every correctness
stage that ran has found the sides equal, and only when both sides produced usable test evidence. A
side whose test run reported no pass/fail counts has not proven it is equally correct, so that battle
ends as a tie with the missing evidence named in the caveats.

Raw test count is never a signal. A side that generates nine passing tests against a side with four
is still a tie on the tests stage; if test creation matters for a task, express it as an assertion.

## Efficiency tie-breaker

Efficiency compares only metrics that BOTH sides reported as observed or calculated. An estimated
value (a cost the CLI did not report, priced from a token count) is excluded, and so is any metric
one side lacks. Each usable metric contributes a relative advantage:

```
advantage(metric) = (b - a) / max(|a|, |b|)      # positive favours A; lower is better for every metric
score = sum(weight_m * advantage_m) / sum(weight_m)   # weights renormalised over the usable metrics
```

Defaults, configurable per battle under `evaluation.efficiency`:

| Metric    | Weight |
| --------- | ------ |
| tokens    | 0.40   |
| cost      | 0.35   |
| wall time | 0.25   |

`minAdvantage` (default 0.05): if `|score|` is under it the battle is a tie. A 3% token difference on
one run is noise, not a result. A weight of 0 removes that metric from the comparison entirely.

The verdict carries the whole calculation in `verdict.efficiency`: winner, signed advantage, the
threshold, each metric with both values and its weight, and every excluded metric with the reason. A
battle that used non-default weights is flagged `custom_efficiency_config` by the integrity checks
so a reader can see it (see [Ratings](/docs/ratings)).

## What the record exposes

```
verdict.winner            a | b | tie | inconclusive
verdict.method            deterministic | deterministic+judge | insufficient
verdict.confidence        0.1 .. 0.95; stage confidence minus 0.1 per deterministic evaluator that could not run
verdict.decisiveFactors   the stage that decided, e.g. ["efficiency"]
verdict.reasons           sentences that name the numbers
verdict.caveats           everything a reader should know before quoting the result
verdict.breakdown         one row per stage: factor, result (a | b | tie | n/a), detail
verdict.efficiency        the tie-breaker in full (see above)
verdict.judge             the blind judge's opinion, or null; never authoritative
```

The same breakdown is shown on the battle page, in `arena battle --json`, in the HTML report, in the
MCP `arena_get_results` tool and in `GET /api/v1/battles/:id`.

## Example

Both sides passed the repository tests, introduced no regressions and satisfied both assertions.
Side A used 24% fewer tokens and cost 56% less; side B finished 33% faster.

```
score = (0.40 * 0.244 + 0.35 * 0.562 + 0.25 * -0.325) / 1.0 = 0.213
```

Side A wins the efficiency tie-breaker with a weighted advantage of 21%, confidence 0.55 minus 0.10
for the build checks that did not run. That is the bundled demo battle (`arena demo`).

## The judge

`evaluation.judge.enabled` runs a second agent as a blind judge: it sees randomised labels, never the
harness names, and returns a preference with a rationale. The opinion is stored, shown as
subjective, and added to the caveats. When the deterministic result is a tie or inconclusive the
method becomes `deterministic+judge` so a reader knows an opinion exists, and the winner is still the
deterministic one.
