# example-harness

A small, working example of the Harness Adapter Protocol. Point Arena at this directory and it is
applied to a battle workspace exactly as a GitHub harness would be.

## What a harness is

A harness is the setup around an agent: instruction files, subagents, skills, hooks, MCP servers,
and per-agent configuration. Arena copies those files into a fresh workspace, runs the official
agent CLI there, and measures what the setup changed. Arena never pays for model usage and never
reads provider credentials.

## What is in here

- `CLAUDE.md` - 15 working rules, read by Claude Code at the workspace root.
- `AGENTS.md` - the same contract in the file Codex reads.
- `.claude/settings.json` - one harmless PostToolUse hook that echoes a line.
- `.claude/agents/reviewer.md` - a review subagent.
- `.claude/skills/tests-first/SKILL.md` - a skill that forces a failing test first.
- `arena.yaml` - the manifest below.

## arena.yaml

- `arena: 1` and `name` are the only required keys.
- `agents` lists the agent ids this harness supports; omit it to allow any.
- `files` lists paths copied into the workspace root. Omit it and Arena auto-detects
  (`CLAUDE.md`, `.claude/`, `AGENTS.md`, `.codex/`, `GEMINI.md`, `.gemini/`, `opencode.json`,
  `.opencode/`, `.mcp.json`). Paths may not be absolute, contain `..`, or be symlinks.
- `install`, `prepare`, and `cleanup` are shell commands. This harness declares none, so Arena runs
  it without asking for trust. When a harness does declare one, Arena prints the command verbatim
  and runs it only after you approve it.
- `agentConfig.<agent-id>` carries per-agent extras: `args`, `env`, `settings`, `mcpConfig`,
  `systemPromptAppend`, `model`. Relative paths resolve inside the harness directory.

## Collisions

The repository under test always wins: a file the workspace already has is kept. The one exception
is a root `CLAUDE.md`, which is applied as `.claude/CLAUDE.md` so both are readable.
