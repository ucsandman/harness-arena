# Decisions

Durable architecture, product and stack decisions. Newest first. The competitive-platform design (Glicko, commit pinning, integrity gates, local execution of challenges) is in `docs/RATINGS.md`, `docs/CHALLENGES.md` and `docs/HARNESS-PROTOCOL.md`.

## 2026-09-20 Hosting: Vercel (apps/web) + Neon Postgres

- One Vercel project, root directory `apps/web`, build `pnpm -w run build` so the workspace packages compile before `next build`. Git-linked to `ucsandman/harness-arena`, production = `main`.
- Neon project `harness-arena` (aws-us-east-1, Postgres 17). The app migrates on first request, so no deploy step touches the schema by hand.
- `ARENA_TRUSTED_PROXY_HOPS=1`: Vercel appends exactly one hop to `x-forwarded-for`; rate limits key on the real client.
- Analytics: Vercel Web Analytics via `@vercel/analytics/next` in the root layout, the only third-party script on the page.
- Google Search Console: URL-prefix property `https://harness-arena-xi.vercel.app/`, verified by the `google-site-verification` meta tag set in `apps/web/app/layout.tsx` (2026-09-20). Removing the tag revokes it.
- No custom domain yet; the canonical URL is `https://harness-arena-xi.vercel.app` until one is chosen (DNS is a hard stop).

## 2026-09-19 MCP runner owns "done"

`arena_get_battle` reports the runner's status while this server still owns the battle. The record on disk turns terminal before the report, upload and worktree cleanup finish, and "completed" must always mean the next battle can start.
