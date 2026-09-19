# Security model

Harness Arena runs other people's harness repositories against other people's code repositories, using
CLIs that hold the user's own provider sessions. Treat everything that enters the system as adversarial.

## Assets

1. Provider credentials held by the agent CLIs (Claude Code, Codex, Gemini CLI, OpenCode).
2. The user's source code, working tree, and environment variables.
3. The user's Arena account and device tokens.
4. The integrity of published battle results and ratings.
5. The web server and other tenants' data.

## Non-negotiables

- **Arena never reads, copies, proxies, or uploads provider credentials.** Adapters spawn the official CLI and let it authenticate itself. No adapter reads `~/.claude/.credentials.json`, keychains, `~/.codex/auth.json`, or Google tokens. `validate()` may only ask the CLI itself (for example `--version`).
- **The web server never executes harness or repository code.** GitHub import inspects repositories through the GitHub REST API (tree listing + file contents), never by cloning or running anything.
- **The user's checkout is never modified.** Arena keeps its own bare mirror and gives every run a detached git worktree of that mirror.
- **No model spend on Arena's behalf.** Nothing in this repository holds a provider key or calls a model API. Verified cloud battles are designed in the data model and deliberately not hosted.

## Threats and controls

| Threat                                                            | Control                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious `arena.yaml` (install/prepare/cleanup commands)         | Commands are printed verbatim and require explicit trust (`--trust` or interactive approval) before anything runs. Untrusted harnesses with commands never execute. Commands run in the harness checkout or the workspace, never in the user's repository.                                              |
| Shell injection through task text, file names, or manifest values | Adapters build fixed argv arrays and deliver the prompt on **stdin**. No provider CLI is ever invoked through a shell with interpolated text. Test commands authored by the user run through the shell by design and are shown as such.                                                                 |
| Path traversal / symlink attacks in harness files                 | `applyHarness` resolves every source path, rejects `..` and absolute paths, refuses anything outside the harness root, skips symlinks (never follows), and refuses to write outside the workspace. Fake-adapter fixtures are held to the same containment rule.                                         |
| Repository git hooks                                              | Every git invocation Arena makes sets `core.hooksPath` to an empty directory; hooks in the mirrored repository never run during clone, fetch, worktree checkout, or diff.                                                                                                                               |
| Dependency lifecycle scripts                                      | Running the task may execute `npm install` and similar as part of the agent's work; that is inherent to the task and runs inside the disposable worktree. The report discloses every command the harness declared.                                                                                      |
| Secret exposure in telemetry                                      | The redactor scrubs known token formats, `KEY=value` secrets, PEM blocks, bearer headers, and every environment value that looks like a secret before events touch disk or the network. Environment variable values are never uploaded; only the names Arena added appear in the invocation disclosure. |
| Credential theft by a harness                                     | Harness code runs with the user's privileges (unavoidable in local mode) and is disclosed beforehand. Local mode is for harnesses the user chooses to trust; verified cloud mode is the answer for untrusted harnesses and is designed but not hosted.                                                  |
| Event poisoning / oversized logs / DoS on ingest                  | Zod validation on every event, per-string (16 KB), per-event (64 KB), per-batch (500) and per-battle (50,000) caps, body size limits, per-token rate limiting, and append-only sequence numbers. Invalid events are rejected and counted, never stored.                                                 |
| Malicious terminal output (ANSI, control chars)                   | ANSI escapes are stripped before rendering; the report and the web app render text only (no HTML injection paths: React escaping, `textContent` in the static report, JSON embedded with `<` escaped).                                                                                                  |
| XSS through agent output on the web                               | No `dangerouslySetInnerHTML`; markdown docs are rendered without raw HTML; strict `Content-Security-Policy`, `X-Frame-Options: DENY`, `nosniff`, referrer policy.                                                                                                                                       |
| Cross-tenant access                                               | Every battle query is scoped by visibility and owner; private battles are only readable by their owner's session or device token. Device tokens are hashed at rest, revocable, and scoped.                                                                                                              |
| Websocket/SSE abuse                                               | The stream endpoint is read-only, visibility-checked, heartbeat-bounded, and backed by database polling (no shared in-memory fan-out to abuse).                                                                                                                                                         |
| Unsafe archive extraction                                         | Arena never extracts archives. Harnesses and repositories are obtained with `git clone`; the web inspects through the API.                                                                                                                                                                              |
| Interruption / crashes                                            | Process trees are killed on abort or timeout (`taskkill /T` on Windows, process-group kill elsewhere); records are flushed after every phase; worktrees are removed in `finally`; `arena doctor` reports and removes orphaned workspaces.                                                               |

## Local-mode disclosure

Before a battle runs, the CLI prints for each side: the agent binary, the exact argv (never the prompt body), the environment variable **names** Arena added, the harness files that will be copied, and any commands the harness declared. Non-interactive runs must pass `--trust` to execute declared commands.

## Reporting a vulnerability

Open a private security advisory on the repository or email the maintainers listed in `package.json`. Please do not file public issues for credential or sandbox-escape problems.
