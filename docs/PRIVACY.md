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

| Level     | What is sent                                                                             |
| --------- | ---------------------------------------------------------------------------------------- |
| `none`    | nothing (default)                                                                        |
| `metrics` | the record: metrics, verdict, evaluation summary, environment, harness names and commits |
| `events`  | metrics + the event stream                                                               |
| `full`    | events + artifacts (unified diff, final assistant message)                               |

Exclusions apply on top of any level (`--exclude a,b,c` or `privacy.exclude`):

| Exclusion        | Effect                                         |
| ---------------- | ---------------------------------------------- |
| `prompts`        | drops tool inputs and user-role text           |
| `model_outputs`  | replaces assistant text with `[excluded]`      |
| `command_output` | drops command and tool outputs                 |
| `file_contents`  | drops file bodies from tool inputs and results |
| `diffs`          | never uploads the patch                        |
| `paths`          | strips workspace paths and cwd values          |

## Redaction

Whether or not you upload, every event and artifact passes through the redactor before it is written:
known token formats, `KEY=value` secrets, private-key blocks, bearer headers, and every environment
variable value that looks like a secret are replaced with `[REDACTED]`. Redaction runs locally; the server
never sees the original.

## What is never collected

- Provider credentials or session files of any agent CLI
- Environment variable values (only the names Arena itself added appear in the disclosure)
- Hostname, username, or home directory
- Your repository checkout (Arena works on its own mirror and worktrees)

## Account data

Signing in with GitHub stores your GitHub id, login, name, and avatar URL. Device tokens are stored as
hashes and can be revoked from the account page. Battles are private by default; you choose `unlisted` or
`public` per battle.
