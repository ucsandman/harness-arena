# Event protocol (v1)

Every observation Arena makes during a battle is an **event**. Events are normalized across agents,
versioned, validated with Zod (`@harness-arena/protocol`), streamed to the web app in real time, and stored
as `events.ndjson` next to every local battle.

Design rules:

1. **Never fabricate telemetry.** An adapter emits only what the provider CLI actually reported. Anything
   Arena computes afterwards (diff stats, timings) is marked `derived`. Anything the CLI cannot report is
   simply absent, and the matching metric is `unavailable`.
2. **Every event says where it came from.** `source.adapter` names the adapter, `source.native` names the
   provider's own event type (for example `assistant.tool_use` for Claude Code, `item.completed` for Codex).
3. **One time axis.** `tOffsetMs` is milliseconds since the battle started, so both runs can be scrubbed
   together in the report.
4. **Bounded.** Strings are truncated at 16 KB, events at 64 KB, upload batches at 500 events, and a battle at
   50,000 stored events. Truncation sets `truncated: true`; it never drops the event.

## Envelope

```json
{
  "v": 1,
  "id": "evt_3k9xq2m7n4p8w1zt",
  "battleId": "btl_8f2h1kd93mq0x7a2",
  "runId": "run_0p9x2mq7d1k3w8zt",
  "side": "a",
  "seq": 42,
  "ts": "2026-09-19T12:23:21.940Z",
  "tOffsetMs": 37210,
  "type": "tool.called",
  "source": { "adapter": "claude-code", "native": "assistant.tool_use" },
  "confidence": "observed",
  "payload": { "toolId": "toolu_01...", "name": "Read", "input": { "file_path": "src/auth/session.js" } }
}
```

| Field          | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `v`            | protocol version, always `1` today                                                    |
| `runId`/`side` | `null` for battle-level events (`battle.started`, `evaluation.*`, `battle.completed`) |
| `seq`          | monotonic per battle; the SSE stream and the report scrubber key on it                |
| `confidence`   | `observed` (CLI reported it), `derived` (Arena computed it), `estimated` (heuristic)  |

## Event types

| Type                   | Payload (abridged)                                                                    | Typical source                                                   |
| ---------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `battle.started`       | title, a/b labels, mode, demo                                                         | arena                                                            |
| `battle.completed`     | status, winner, durationMs                                                            | arena                                                            |
| `run.started`          | side, agent, agentVersion, model, harness, harnessCommit, workspace                   | arena                                                            |
| `run.completed`        | side, status, exitCode, durationMs, reason                                            | arena                                                            |
| `agent.started`        | sessionId, model, version, tools                                                      | claude-code `system.init`, codex `thread.started`, gemini `init` |
| `agent.output`         | role, text, truncated, final                                                          | assistant text blocks / result                                   |
| `agent.thinking`       | chars (never the text)                                                                | thinking blocks, codex `reasoning`                               |
| `model.request`        | model, turn                                                                           | rarely observable                                                |
| `model.response`       | model, stopReason, usage {input/output/cacheRead/cacheWrite/total tokens, costUsd}    | per-message usage, `turn.completed`                              |
| `tool.called`          | toolId, name, input, parentToolId, summary                                            | `tool_use` blocks                                                |
| `tool.result`          | toolId, name, ok, output, truncated, durationMs                                       | `tool_result` blocks                                             |
| `command.started`      | commandId, command, cwd                                                               | Bash/PowerShell tool use, codex `command_execution`              |
| `command.completed`    | commandId, exitCode, durationMs, output                                               |                                                                  |
| `file.read`            | path, bytes                                                                           | Read/Glob/Grep                                                   |
| `file.changed`         | path, kind (create/modify/delete/rename), linesAdded, linesRemoved                    | Write/Edit (observed), git diff (derived)                        |
| `subagent.spawned`     | subagentId, name, description                                                         | Task/Agent tool use                                              |
| `subagent.completed`   | subagentId, status, durationMs                                                        |                                                                  |
| `test.started`         | command, phase (baseline/post)                                                        | evaluator                                                        |
| `test.completed`       | command, phase, exitCode, passed, failed, skipped, total, durationMs, parser          | evaluator                                                        |
| `context.compacted`    | trigger                                                                               | claude-code compact boundary                                     |
| `limit.hit`            | kind (timeout, max_turns, max_budget, max_output, provider_limit, rate_limit), detail | adapter or arena                                                 |
| `human.intervention`   | kind (permission/input/unknown), detail, automated                                    | permission denials                                               |
| `evaluation.started`   | evaluatorId, side                                                                     | evaluator                                                        |
| `evaluation.completed` | evaluatorId, side, status, summary                                                    | evaluator                                                        |
| `warning`              | code, message                                                                         | any                                                              |
| `error`                | code, message, fatal                                                                  | any                                                              |
| `interrupt`            | reason (user/timeout/signal/limit), detail                                            | arena                                                            |

The authoritative list, with exact Zod payloads, is `packages/protocol/src/events.ts`.

## What each agent can report

Verified on 2026-09-19 against the installed CLIs (see `packages/adapters/fixtures/README.md`):

| Signal                | Claude Code 2.1.x                                           | Codex 0.15x                                 | Gemini CLI 0.55.x       | OpenCode 2.0.x                        |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------- | ----------------------- | ------------------------------------- |
| tokens                | observed (per message + total)                              | observed (per turn)                         | observed (result stats) | observed (step_finish)                |
| cost                  | observed (list-price estimate; not a subscription charge)   | unavailable                                 | unavailable             | observed when the provider reports it |
| tool calls            | observed                                                    | observed (items)                            | observed                | observed                              |
| commands              | observed                                                    | observed                                    | observed (shell tool)   | observed (bash tool)                  |
| file changes          | observed + derived                                          | observed + derived                          | derived                 | derived                               |
| subagents             | observed                                                    | unavailable                                 | unavailable             | unavailable                           |
| turns                 | observed                                                    | derived                                     | derived                 | derived                               |
| user config isolation | yes (`--setting-sources project,local --strict-mcp-config`) | yes (`--ignore-user-config --ignore-rules`) | no                      | no                                    |

"Derived" file changes come from `git diff` against the start commit and are identical for every agent.

## Metrics

`RunMetrics` is a fixed set of keys (`packages/protocol/src/metrics.ts`), each a `{ value, status, source,
unit, note }`. Status is one of `observed`, `calculated`, `estimated`, `unavailable`. The report never
renders an unavailable metric as `0`.

## Battle spec and record

`BattleSpec` (input, `battle.json`) and `BattleRecord` (output, includes runs, metrics, evaluation, verdict,
insights, environment) are in `packages/protocol/src/battle.ts`. A `ReportBundle` is a record plus its
events; it is what `report.html` embeds and what the web app renders.

## Verdict, integrity and provenance

`Verdict` (`packages/protocol/src/evaluation.ts`) carries the stage-by-stage `breakdown`, the full
`efficiency` tie-breaker (winner, advantage, threshold, per-metric values and weights, exclusions) and
the optional judge opinion. `evaluation.efficiency` in the spec configures the weights and the minimum
advantage. See [Verdicts](/docs/verdicts).

`BattleRecord.integrity` (`packages/protocol/src/integrity.ts`) lists the rating-eligibility flags
with a severity each, the duplicate fingerprint and the version that computed them. The server
recomputes it on upload and stores its own copy; a client's copy is informational.

`spec.benchmark` (`battleBenchmarkRefSchema`) names the pack slug, the immutable version id, the task
id and the trial number when a battle came from a benchmark pack. `spec.arena` names the challenge,
experiment, tournament match or bounty submission the battle was run for; the server links the battle
only after verifying the competitors match.

Benchmark packs (`packages/protocol/src/benchmarks.ts`), challenges, experiments, tournaments,
bounties, lineage and head-to-head records (`packages/protocol/src/arena.ts`) and the statistics
shapes (`packages/protocol/src/stats.ts`) are protocol types too: every API response is validated
against them, and the CLI prints them with `--json`.

## Versioning

- `v` on every event and `protocolVersion` on every record. Breaking changes bump the number; additive
  fields do not.
- Unknown event types fail validation at ingest and are counted as `rejected`; they never poison the store.
