# Privacy

Battles often run on proprietary code. Arena is designed so that **nothing leaves your machine unless you
say so**, and when you do, you choose exactly what.

## Local-only battles

`arena battle --local-only` (or simply never running `arena login`) keeps everything under
`~/.harness-arena/battles/<id>/`:

- `battle.json`: the record (spec, metrics, evaluation, verdict, environment)
- `events.ndjson`: every event
- `runs/<side>/`: the raw provider log and the patch
- `report.html`: a self-contained report that opens offline

No network requests are made by Arena itself. The agent CLIs talk to their own providers as they always do.

## Connected battles

After `arena login`, each battle has an upload level (`--upload <level>` or `privacy.upload` in `battle.json`):

| Level     | What is sent                                                                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`    | nothing (default). No request is made at all.                                                                                                                                                                               |
| `metrics` | the record only: metrics, verdict, evaluation summary, environment, harness names and commits, the task **title** and source. The task prompt is replaced with `[excluded]`, and no events, diffs or model output are sent. |
| `events`  | everything `metrics` sends **plus** the task prompt and the event stream (each event already filtered by the exclusions below). Still no artifacts.                                                                         |
| `full`    | everything `events` sends **plus** the artifacts: the unified diff and the final assistant message.                                                                                                                         |

At every level the agent environment variables supplied in the battle spec are sent as **names with
`[REDACTED]` values**, and the local path of the raw provider log is never sent.

A battle uploaded at `none` cannot exist on the server, so it cannot be rated, linked to a challenge
or counted in an experiment. `metrics` is enough for all of those: ratings, head-to-head records,
experiment summaries and badges are computed from the record alone. Public leaderboards, harness
profiles, challenge pages and battle cards show only battles whose visibility is `public`; a private
battle still moves its owner's rating (the verdict is a fact about the battle) but never appears in
public lists or head-to-head pages.

Exclusions apply on top of any level (`--exclude a,b,c` or `privacy.exclude`):

| Exclusion        | Effect                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `prompts`        | drops tool inputs, user-role text, and the task prompt (`[excluded]`) at any level                                 |
| `model_outputs`  | replaces assistant text with `[excluded]`                                                                          |
| `command_output` | drops command and tool outputs                                                                                     |
| `file_contents`  | drops file bodies from tool inputs and results                                                                     |
| `diffs`          | never uploads the patch                                                                                            |
| `paths`          | strips workspace paths, cwd values, changed-file paths, and absolute paths in the invocation disclosure (`<path>`) |

## Redaction

Whether or not you upload, every event and artifact passes through the redactor before it is written:
known token formats, `KEY=value` secrets, private-key blocks, bearer headers, credentials embedded in a
URL (`https://user:token@host` keeps the scheme and the host only), and every environment variable value
that looks like a secret are replaced with `[REDACTED]`. That includes the unified diff, the final
assistant message and the raw provider log under `runs/<side>/raw.log`. `privacy.redact: false` switches off
only the heuristic scans (token shapes, headers, `KEY=value`), only while `upload` is `none`; the exact values of
your environment secrets and of `agent.env` are scrubbed on every battle. Redaction runs locally; the server
never sees the original.

API keys you pass to an agent through the battle spec (`competitors.<side>.agent.env`) or through a
harness `arena.yaml` (`agentConfig.<agent>.env`) are handed to the child process and nowhere else: the
record on disk, the report and every upload keep the variable **names** and replace the values with
`[REDACTED]`, regardless of the `redact` setting.

## What is never collected

- Provider credentials or session files of any agent CLI
- Environment variable values (only the names Arena itself added appear in the disclosure)
- Hostname, username, or home directory
- Your repository checkout (Arena works on its own mirror and worktrees)

## Account data

Signing in with GitHub stores your GitHub id, login, name, and avatar URL. Device tokens are stored as
hashes on the server and can be revoked from the account page. The local copy lives in
`ARENA_HOME/config.json`, written with mode `0600` on POSIX systems; **on Windows there are no POSIX
modes**, so the file is protected only by the ACL it inherits from your user profile directory (the
`chmod` is attempted and its failure ignored). Battles are private by default; you choose `unlisted` or
`public` per battle.
