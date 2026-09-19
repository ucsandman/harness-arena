# @harness-arena/harness

Harness resolution and inspection. Turns a `HarnessRef` (`vanilla`, a GitHub URL, a git URL, or a local
path) into a checkout, a commit, an `arena.yaml` manifest, and an inspection report, then applies it to a
battle workspace. Nothing in this package executes repository code: inspection runs over a file-listing
abstraction, git runs with argument arrays and hooks disabled, and manifest commands run only after the
user has trusted the harness.

## API

```ts
import {
  parseHarnessSource,
  parseGitHubUrl,
  createLocalFileSource,
  createGitHubFileSource,
  findManifest,
  inspectHarness,
  resolveHarness,
  applyHarness,
  describeExecution,
} from '@harness-arena/harness';

const harness = await resolveHarness(
  { source: 'https://github.com/owner/repo', trusted: false },
  { home: arenaHome, agentId: 'claude-code', logger },
);

const disclosure = describeExecution(harness); // { commands, files } shown before asking for trust
const applied = await applyHarness(harness, {
  workspace,
  agentId: 'claude-code',
  trusted: true,
  runner,
  env: {},
  logger,
});
```

- `FileSource` (`list`, `read`, `exists`, `listResult`) is the only thing inspection needs; the CLI uses
  `createLocalFileSource`, the web app `createGitHubFileSource` (tree + raw contents, typed errors for
  404 / rate limit / network).
- `resolveHarness` takes `git` (a `GitRunner`) and `fetchImpl` so tests inject fakes; `mode: 'inspect'`
  inspects a GitHub harness over the API without cloning.
- `applyHarness` copies `arena.yaml` `files` (or the auto-detected set), refusing absolute paths, `..`,
  symlinks and anything resolving outside the harness or the workspace. A workspace file always wins a
  collision, except a root `CLAUDE.md`, which is applied as `.claude/CLAUDE.md`.
- Commands: `install` (in the harness directory) then `prepare` (in the workspace), through the platform
  shell, with `ARENA_WORKSPACE`, `ARENA_HARNESS_DIR` and `ARENA_AGENT` added. Untrusted plus commands
  throws `HarnessTrustRequiredError` before anything is copied.

## Example harness

`examples/example-harness/` is a real, minimal harness (CLAUDE.md, hook, subagent, skill, AGENTS.md,
`arena.yaml`); `examples/example-harness/README.md` documents the protocol. Inspection fixtures live in
`examples/fixtures/harness-repos/`.

## Checks

```
pnpm exec tsc -p packages/harness/tsconfig.json --noEmit    # sources
pnpm exec tsc -p packages/harness/tsconfig.test.json --noEmit  # sources + tests
pnpm exec vitest run packages/harness
pnpm exec eslint packages/harness
```
