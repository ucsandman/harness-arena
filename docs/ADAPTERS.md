# Agent adapters

An adapter wraps an **official** coding-agent CLI. It detects the binary, builds a fixed argument list, feeds
the task on stdin, and translates the CLI's own streaming output into protocol events. It never re-implements
the provider, never touches credentials, and never fabricates telemetry.

Interface (`packages/adapters/src/types.ts`):

```
detect()  validate()  getVersion()  capabilities()  prepare()  execute()  cleanup()  createParser()
```

`createParser()` returns a pure line parser so every adapter is tested against captured fixtures without
spawning anything. `execute()` uses an injectable `ProcessRunner`, so the engine and the tests share one
process implementation: argument arrays only (no shell), stdin delivery, output caps, timeouts, and
whole-process-tree kills (`taskkill /T` on Windows, process-group kill elsewhere).

## Built-in adapters

### Claude Code (`claude-code`)

Verified live on 2026-09-19 with Claude Code 2.1.278 on Windows 11 (fixture: `fixtures/claude-code/success.ndjson`).

```
claude -p --output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence
       --setting-sources project,local --strict-mcp-config
       [--model <m>] [--max-turns <n>] [--max-budget-usd <n>]
       [--settings <harness settings.json>] [--mcp-config <harness .mcp.json>] [--append-system-prompt <text>]
       <harness/agent extra args>
```

Prompt on stdin. `--setting-sources project,local` and `--strict-mcp-config` exclude the user's global
`~/.claude` settings and MCP servers so that only the harness differs between sides (user config isolation:
**yes**). `CLAUDECODE` is removed from the child environment so a battle can be started from inside a Claude
Code session.

Telemetry: per-message and total token usage (observed), `total_cost_usd` (observed; a list-price estimate
computed by the CLI, not a subscription charge), model, tool calls and results, commands, file reads and
writes, subagents (`subagent_stats`), turns, thinking length, context compaction, permission denials.

### Codex (`codex`)

Codex CLI 0.154.0. Real failure fixture (`fixtures/codex/usage-limit.ndjson`) captured live; the success
shape follows OpenAI's documented `codex exec --json` JSONL and is marked synthetic.

```
codex exec --json --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules
      --dangerously-bypass-approvals-and-sandbox -C <workspace> [-m <model>] <extra args> -
```

Prompt on stdin (`-`). `--ignore-user-config --ignore-rules` isolate user config (**yes**). Windows has no
Codex sandbox, so approvals and the sandbox are bypassed inside the disposable worktree.

Telemetry: tokens per turn (observed), commands with exit codes and output, file changes, agent messages,
reasoning length. Cost: **unavailable** (Codex does not report it). Subagents: unavailable.

### Gemini CLI (`gemini-cli`)

Gemini CLI 0.55.1. Real failure fixture (`fixtures/gemini-cli/auth-error.txt`: the individual Code Assist tier
was retired, which the adapter classifies as an auth error). Success shape from the documented
`--output-format stream-json` and marked synthetic.

```
gemini --output-format stream-json --approval-mode yolo --skip-trust [-m <model>] <extra args>
```

Prompt on stdin. User config isolation: **no** (no flag to ignore `~/.gemini`); the record says so.

Telemetry: result stats (tokens, tool calls, duration), tool use and results, messages. Cost: unavailable.

### OpenCode (`opencode`)

OpenCode 2.0.4. Real failure fixture (`fixtures/opencode/provider-error.ndjson`, no provider configured).
Success shape from the documented `run --format json` and marked synthetic.

```
opencode run --standalone --format json --auto [--model provider/model] <extra args> [message]
```

User config isolation: **no**. Telemetry: text parts, tool use with state, per-step tokens and cost when the
provider reports it.

### Fake (`fake`)

A deterministic adapter that replays a fixture script (`fixtures/fake/*.json`): timed events plus file
operations applied to the workspace, so `git diff`, tests, and evaluators see real changes. Used by the test
suite, `arena demo`, and CI. It costs nothing and never touches the network. Fixture names: `demo-harness-a`,
`demo-vanilla-b`, `quick-success`, `failure`, `timeout`, `interrupted`, `usage-limit`.

## Detection

`arena agents` runs every adapter's `detect()`: binary on `PATH` (with `.cmd`/`.exe` handling on Windows),
`--version`, and an auth status of `ok`, `missing`, or `unknown`. Auth is never checked by reading credential
files; the CLI itself is the only source of truth.

## Writing a community adapter

1. Copy `src/fake` or `src/claude-code` as a template.
2. Capture real output of the CLI's non-interactive streaming mode and commit a redacted fixture.
3. Map native events to protocol events; leave out what the CLI does not report and declare it in
   `capabilities()`.
4. Deliver the prompt on stdin. Build argv as an array. Never use a shell.
5. Add parser and `prepare()` tests. Register in `builtinAdapters`.
