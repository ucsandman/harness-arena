# Decisions

Durable architecture, product and stack decisions. Newest first. The competitive-platform design (Glicko, commit pinning, integrity gates, local execution of challenges) is in `docs/RATINGS.md`, `docs/CHALLENGES.md` and `docs/HARNESS-PROTOCOL.md`.

## 2026-11-08 Battle lifecycle is an explicit, forward-only table

- `BATTLE_TRANSITIONS` (`packages/protocol/src/battle-lifecycle.ts`) is the one source for battle status changes. Before it, `PATCH /api/v1/battles/:id` overwrote any status, so `failed -> completed` and `completed -> running` went through and could settle ratings on a rewritten result.
- Forward only, with skips: the engine registers a battle as `pending` and uploads once at the end, so the server sees `pending -> completed` from every CLI in the field. A strict one-step table would refuse that.
- Terminal is final; writing the same status again is a no-op (visibility PATCH, retry after a lost response, re-seed). A refusal is a 409 `illegal_transition` in the usual error envelope plus `current`, `requested`, `allowed`.
- A re-run is a new battle: `arena run --battle` refuses a finished id. An older CLI can still re-upload `completed -> completed` over the same id; freezing a terminal record needs record-equality rules and is out of scope.
- Deferred: the server learning `preparing`/`running`/`evaluating` (the engine PATCHing each status). It would break the single-PATCH upload the engine tests pin, a status-only terminal PATCH would settle links and ratings on a record with no verdict, and a crashed run would stay `running` on the server with no way to re-run it.

## 2026-09-20 Hosting: Vercel (apps/web) + Neon Postgres

- One Vercel project, root directory `apps/web`, build `pnpm -w run build` so the workspace packages compile before `next build`. Git-linked to `ucsandman/harness-arena`, production = `main`.
- Neon project `harness-arena` (aws-us-east-1, Postgres 17). The app migrates on first request, so no deploy step touches the schema by hand.
- `ARENA_TRUSTED_PROXY_HOPS=1`: Vercel appends exactly one hop to `x-forwarded-for`; rate limits key on the real client.
- Analytics: Vercel Web Analytics via `@vercel/analytics/next` in the root layout, the only third-party script on the page.
- Google Search Console: URL-prefix property `https://harness-arena-xi.vercel.app/`, verified by the `google-site-verification` meta tag set in `apps/web/app/layout.tsx` (2026-09-20). Removing the tag revokes it.
- No custom domain yet; the canonical URL is `https://harness-arena-xi.vercel.app` until one is chosen (DNS is a hard stop).

## 2026-09-19 MCP runner owns "done"

`arena_get_battle` reports the runner's status while this server still owns the battle. The record on disk turns terminal before the report, upload and worktree cleanup finish, and "completed" must always mean the next battle can start.

## 2026-11-13 Serverless documentation assets

Documentation is bundled as generated JSON at build time from the repository Markdown. Runtime reads no longer require a checkout, workspace marker, or symlink-sensitive external file traces. Next config generates the bundle for builds/dev, package builds generate it before typechecking, and Vitest config generates it before tests. The bundle is ignored, deterministic, and rewritten only when source content changes; the URL registry still limits which documents can be read. An initial explicit external tracing approach built successfully but Vercel rejected its serverless package, so it was not merged.
