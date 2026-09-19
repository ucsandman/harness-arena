# Demo battle

`battle.json` and `events.ndjson` are the output of `arena demo`: two deterministic fake-adapter runs
("Agnostic AI" vs "Vanilla Claude Code") fixing a session-expiry bug in the small project under
`packages/adapters/fixtures/fake/demo-project`. No model was involved; every number is derived from the
fixture timelines and real git diffs. The record is marked `demo: true` and is never counted in ratings.

Regenerate with `arena demo --export examples/demo`. `pnpm db:seed` loads it into the web app.
