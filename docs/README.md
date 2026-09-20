# Harness Arena

Harness Arena runs two AI coding-agent setups ("harnesses") against the same task, under the same
starting conditions, and produces a report you can argue with.

A harness is everything around the model: instructions, skills, hooks, MCP servers, subagents,
settings. Arena holds the task, the repository commit, the limits and the evaluation constant, so the
harness is the variable under test.

**We sell the referee, not the electricity.** Arena spawns the official agent CLI you already have
authenticated (`claude`, `codex`, `gemini`, `opencode`), so model usage is billed to the subscription
you already pay for. Arena never proxies model traffic and never touches provider credentials.

What you get from one battle:

- Normalized, versioned events from both runs on a single time axis.
- Metrics that carry their provenance: `observed`, `calculated`, `estimated` or `unavailable`. A CLI
  that does not report cost shows `n/a`, never `$0`.
- Deterministic evaluation first (repo tests with a baseline, build, lint, typecheck, task assertions,
  diff signals). An optional blind LLM judge is labeled subjective and never decides alone.
- A verdict that names its decisive evidence and its caveats, or says `inconclusive`.

Where to go next:

- [Getting started / CLI](/docs/cli): install and run your first battle.
- [Architecture](/docs/architecture): how the engine, adapters, evaluator and web app fit together.
- [Event protocol](/docs/protocol): the envelope every adapter emits.
- [Harness protocol](/docs/harness-protocol): `arena.yaml`, for making a repository a competitor.
- [Agent adapters](/docs/adapters): what each CLI reports, and what it cannot.
- [Verdicts](/docs/verdicts): the correctness hierarchy and the efficiency tie-breaker, with the arithmetic.
- [Ratings](/docs/ratings): Glicko ratings, the community and verified pools, commit pinning, anti-gaming.
- [Benchmarks](/docs/benchmarks): reusable, content-addressed task packs and `arena benchmark`.
- [Experiments](/docs/experiments): regression and component-ablation runs, and how their summaries are computed.
- [Challenges](/docs/challenges): challenges, tournaments and bounties, and who executes what.
- [Lineage](/docs/lineage): declared harness ancestry and components.
- [Security](/docs/security) and [Privacy](/docs/privacy): trust boundaries and local-only mode.
- [Contributing](/docs/contributing): develop, test and extend Arena.
