# Harness protocol: `arena.yaml` (v1)

A **harness** is everything that shapes how a coding agent works on a task: instructions (`CLAUDE.md`,
`AGENTS.md`, `GEMINI.md`), settings, hooks, skills, subagents, commands, MCP servers, and the scripts that
install them. Any git repository can declare itself Arena-compatible by adding an `arena.yaml`. Repositories
without one still work: Arena auto-detects the common configuration files.

## Minimal example

```yaml
arena: 1
name: my-harness
description: Tests-first Claude Code setup with a reviewer subagent.
agents: [claude-code, codex]
capabilities:
  subagents: true
  hooks: true
  skills: true
```

## Full schema

```yaml
arena: 1 # required, protocol version
name: my-harness # required, lowercase [a-z0-9._-]
version: 2.3.0 # optional, free text
description: ... # optional
homepage: https://... # optional

agents: [claude-code, codex] # agent ids this harness supports; omitted = any

# Files copied from the harness repository into the battle workspace.
# Omitted = auto-detect: CLAUDE.md, .claude/, .mcp.json, AGENTS.md, .codex/, GEMINI.md, .gemini/,
#           opencode.json, opencode.jsonc, .opencode/
files:
  - CLAUDE.md
  - .claude/
  - .mcp.json
target: . # where inside the workspace to place them (default ".")

# Commands. They run on the user's machine ONLY after the user has trusted the harness.
install: # runs in the harness checkout before the battle
  command: npm install
  timeoutMs: 300000
  platforms: [darwin, linux] # optional gate
prepare: # runs in the WORKSPACE after files are applied
  command: node scripts/arena-prepare.mjs
cleanup: # runs in the workspace after the run
  command: node scripts/arena-cleanup.mjs

# Per-agent configuration applied when the harness runs under that agent.
agentConfig:
  claude-code:
    args: ['--effort', 'high'] # extra CLI arguments, passed verbatim (never shell-interpolated)
    env:
      MY_HARNESS_MODE: arena
      MY_HARNESS_ROOT: ${ARENA_HARNESS_DIR} # substitutions: ${ARENA_HARNESS_DIR}, ${ARENA_WORKSPACE}
    settings: .claude/arena-settings.json # passed as --settings (hooks, permissions, model)
    mcpConfig: .mcp.json # passed as --mcp-config (with --strict-mcp-config)
    systemPromptAppend: prompts/arena.md # file (.md/.txt) or literal text; --append-system-prompt
    model: sonnet # default model when the battle does not set one
  codex:
    args: ['--config', 'model_reasoning_effort=high']

capabilities: # informational; shown on the harness profile
  subagents: true
  mcp: true
  hooks: true
  skills: true
  commands: true

metadata: # free-form, ignored by Arena
  maintainer: you
```

Unknown top-level keys are rejected so typos are caught early. The Zod source of truth is
`packages/protocol/src/manifest.ts`.

## Lifecycle

```
resolve   clone the harness repository (or use a local path read-only), record the exact commit
inspect   detect features, read arena.yaml, produce a compatibility report
trust     the CLI prints every install/prepare/cleanup command verbatim and asks for approval
          (non-interactive: --trust). Untrusted harnesses with commands do not run.
install   `install.command` in the harness checkout (env: ARENA_HARNESS_DIR, ARENA_WORKSPACE, ARENA_AGENT)
apply     copy `files` into the workspace (path-contained, symlinks skipped, no overwrite of repository
          files: a harness CLAUDE.md lands in .claude/CLAUDE.md when the repository has its own)
prepare   `prepare.command` inside the workspace
run       the agent CLI starts in the workspace with agentConfig applied
cleanup   `cleanup.command`, then the workspace (a git worktree) is removed
```

Environment variables available to every command and to the agent process:

| Variable            | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| `ARENA_BATTLE`      | `1`                                                        |
| `ARENA_RUN_ID`      | the run id                                                 |
| `ARENA_SIDE`        | `a` or `b`                                                 |
| `ARENA_WORKSPACE`   | absolute path of the workspace                             |
| `ARENA_HARNESS_DIR` | absolute path of the harness checkout (absent for vanilla) |
| `ARENA_AGENT`       | agent id                                                   |

## Fairness notes

- Both sides receive the same repository commit, task text, limits, and evaluation.
- User-level configuration is excluded where the CLI allows it (Claude Code, Codex), so the harness under test is the only difference. Where it cannot be excluded (Gemini CLI, OpenCode), the record says so.
- The `vanilla` harness means "the agent's defaults and the repository's own files, nothing added".

## Auto-detection without a manifest

`arena harness inspect <url|path>` (and the web import page) report:

| Feature            | Looks for                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| CLAUDE.md          | `CLAUDE.md`, `.claude/CLAUDE.md`                                                                                         |
| Claude settings    | `.claude/settings.json`, `.claude/settings.local.json`                                                                   |
| Hooks              | `hooks` in those settings, `.claude/hooks/`                                                                              |
| Skills             | `.claude/skills/*/SKILL.md`                                                                                              |
| Subagents          | `.claude/agents/*.md`                                                                                                    |
| Commands           | `.claude/commands/**/*.md`                                                                                               |
| MCP                | `.mcp.json`, `mcpServers` in settings, `[mcp_servers]` in `.codex/config.toml`, `.gemini/settings.json`, `opencode.json` |
| AGENTS.md / Codex  | `AGENTS.md`, `.codex/config.toml`                                                                                        |
| GEMINI.md / Gemini | `GEMINI.md`, `.gemini/settings.json`                                                                                     |
| OpenCode           | `opencode.json(c)`, `.opencode/`                                                                                         |
| Cursor rules       | `.cursor/rules`, `.cursorrules` (informational; not applied)                                                             |

Compatibility is `ready`, `partial`, `unknown`, or `incompatible`, always with reasons.
