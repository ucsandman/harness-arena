# Adapter fixtures

Every adapter is tested against fixtures, never against a live CLI: the test suite spends nothing and
calls no model. Each fixture below is labelled **real capture** or **synthetic**.

## Real captures

Recorded on 2026-09-19 on Windows 11 by running the official CLIs by hand. Absolute paths, user names
and session identifiers that pointed at the capturing machine were redacted (`C:\Users\user\...`,
`/home/user/...`); nothing else was edited, so the JSON shapes, field names and error strings are the
providers' own.

| File                             | CLI                                                              | What it captures                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude-code/success.ndjson`     | Claude Code 2.1.278 (`-p --output-format stream-json --verbose`) | A complete successful run: `system/init`, thinking blocks, a `Write` tool call and its result, a `rate_limit_event`, and the final `result` line with `usage`, `total_cost_usd`, `num_turns` and `subagent_stats`. |
| `codex/usage-limit.ndjson`       | codex-cli 0.154.0 (`exec --json`)                                | A run refused by the provider: `thread.started`, `turn.started`, a non-fatal `item.completed` error, then the usage-limit `error` and `turn.failed`.                                                               |
| `gemini-cli/auth-error.txt`      | Gemini CLI 0.55.1 (`--output-format stream-json`)                | Plain-text failure output: `IneligibleTierError` (Code Assist for individuals retired), plus extension and hook noise. No JSON lines at all, which is why the parser has to survive prose.                         |
| `opencode/provider-error.ndjson` | OpenCode 2.0.4 (`run --format json`)                             | A provider 500: a single `error` line with `error.type = provider.internal`.                                                                                                                                       |

No successful run could be captured for Codex, Gemini CLI or OpenCode on the capture machine (usage
limit, ineligible account tier, provider outage). Their success paths are covered by the synthetic
fixtures below.

## Synthetic fixtures (written from documentation, not captured)

| File                                  | Built from                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex/synthetic-success.ndjson`      | OpenAI's documented `codex exec --json` JSONL shape: `thread.started`, `turn.started`, `item.started`/`item.completed` with `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, and `turn.completed{usage}`. |
| `gemini-cli/synthetic-success.ndjson` | Gemini CLI's documented `--output-format stream-json` shape: `init`, `message`, `tool_use`, `tool_result`, `result{stats}`.                                                                                                                                            |
| `opencode/synthetic-success.ndjson`   | OpenCode's documented `run --format json` shape: `step_start`, `tool_use` parts with `state`, `text`, `step_finish{tokens, cost}`.                                                                                                                                     |

They describe the same small task as the demo fixtures (a session-expiry unit bug), so numbers across
fixtures stay plausible next to each other. They are **not** evidence about a provider's real output;
when a real success capture becomes available it should replace the synthetic file and the table row.

## Fake-adapter fixtures (`fake/*.json`)

Deterministic replay scripts for `FakeAdapter`, validated on load against the protocol payload
schemas (`fakeScriptSchema`). They emit protocol events on a fixed timeline and apply real
workspace-relative file operations, so `git diff`, the evaluators and the report see a plausible
patch. No model is called and no process is spawned.

| Fixture          | What it replays                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo-harness-a` | 63 tool calls over 4m52s: 6 file reads, 2 test runs, 1 specialist subagent, 2 files changed (fix plus a regression test), 14 turns, 182k input / 9.4k output / 120k cache-read tokens, $2.81.                             |
| `demo-vanilla-b` | 147 tool calls over 3m17s on the same task: 18 reads (several irrelevant), 4 test runs with 2 retries, no subagent, 3 files changed including an unrelated README touch, 27 turns, 391k input / 21k output tokens, $6.42. |
| `quick-success`  | Five events, one file write, done in 2s. Used by fast unit tests.                                                                                                                                                         |
| `failure`        | Errors out and exits 1.                                                                                                                                                                                                   |
| `timeout`        | A ten-minute timeline; with a small `limits.timeoutMs` the replay stops and reports `timed_out`.                                                                                                                          |
| `interrupted`    | A five-minute timeline for abort tests.                                                                                                                                                                                   |
| `usage-limit`    | Mirrors the real Codex capture: `limit.hit` `provider_limit` plus a fatal error.                                                                                                                                          |

Both demo fixtures bootstrap the same tiny Node project (`package.json`, `src/auth/session.js`,
`test/session.test.js`, `README.md`) in which `isExpired` compares a seconds timestamp against
`Date.now()` in milliseconds, then apply the fix. `node --test` fails on the bug and passes at the end
of either replay; the adapter test suite asserts exactly that inside a temporary workspace.

`fake/generate.mjs` regenerates every fake fixture deterministically (no clock, no randomness):

```
node packages/adapters/fixtures/fake/generate.mjs
```

The 63- and 147-call timelines, their per-turn token and cost shares (which sum exactly to the run
totals) and the file operations come from that script, so editing a demo run means editing the script
and re-running it, never hand-patching JSON.
