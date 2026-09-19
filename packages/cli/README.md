# harness-arena

Battle two AI coding-agent harnesses on the same task, with the CLIs and subscriptions you already
have, and get a report that says which setup actually performed better.

A harness is the setup around an agent: `CLAUDE.md`, `AGENTS.md`, `.claude/` skills, hooks, subagents,
MCP servers, per-agent config. Arena copies a harness into a fresh git worktree, runs the **official**
agent CLI there, captures normalized telemetry, evaluates both sides with your repository's own tests,
and renders `report.html`.

Arena never proxies model traffic, never reads provider credentials, and never pays for model usage.
Nothing leaves your machine unless you ask it to.

## Install

```bash
npm install -g harness-arena     # `arena` and `harness-arena`
npx harness-arena demo           # or try it without installing
```

Node 22+, git on `PATH`, and one signed-in agent CLI (Claude Code, Codex, Gemini CLI, OpenCode). The
demo needs none of them.

## Three commands to start

```bash
# 1. See what a battle report looks like: deterministic fixtures, no agent CLI, no model spend.
arena demo

# 2. Your harness against the agent's defaults, on your own repository, nothing uploaded.
arena battle . vanilla --agent claude-code --repo . --tests "npm test" \
  --task "Fix the failing session-expiry test" --local-only

# 3. Is a harness compatible? Read it without executing any of it.
arena harnesses inspect https://github.com/owner/harness
```

Other commands: `arena run <battle.json>`, `arena list`, `arena status --watch`, `arena replay <id>`,
`arena agents`, `arena doctor --fix`, `arena regression <dir> --baseline … --candidate …`,
`arena clean`, `arena login` / `logout` / `whoami`.

Run `arena` with no arguments on a terminal for the interactive menu, or `arena --help` for every flag.

## Documentation

- Full CLI reference, `battle.json` schema, privacy flags, CI usage: [docs/CLI.md](https://github.com/ucsandman/harness-arena/blob/main/docs/CLI.md)
- Harness protocol (`arena.yaml`): [docs/HARNESS-PROTOCOL.md](https://github.com/ucsandman/harness-arena/blob/main/docs/HARNESS-PROTOCOL.md)
- What each agent CLI can and cannot report: [docs/ADAPTERS.md](https://github.com/ucsandman/harness-arena/blob/main/docs/ADAPTERS.md)
- Security and privacy models: [docs/SECURITY.md](https://github.com/ucsandman/harness-arena/blob/main/docs/SECURITY.md), [docs/PRIVACY.md](https://github.com/ucsandman/harness-arena/blob/main/docs/PRIVACY.md)

MIT licensed.
