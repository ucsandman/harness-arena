# Example battle specs

Run one with `arena run <file>`. The schema is `battleSpecSchema` in `packages/protocol/src/battle.ts`.

- `fake-quick.json`: two fake adapters on an empty repository. Costs nothing, finishes in seconds, used by CI.
- `claude-code-issue.json`: a real battle shape: a GitHub issue as the task, a local example harness versus vanilla Claude Code, repository tests as the evaluator, metrics-only upload. Replace `owner/project` before running.
