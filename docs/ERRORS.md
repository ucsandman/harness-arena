# Errors and lessons

One line per break; a full entry when the fix took more than one attempt. Newest first.

## 2026-09-20 Wave 2 sat unverified after a restart

- **Symptom:** commit 12803c0 was pushed with "unverified" in the message; the web build failed on the next session.
- **Root cause:** agents were interrupted by a machine restart; the experiment detail page's `thin` flag narrowed `summary` to `never`, and three MCP tests raced the runner (status "completed" was mirrored before the run promise settled).
- **Fix:** b1742b2. Lesson: after an interrupted wave the first command is `pnpm build`, not a re-read of the plan; it found the only blocking error in one shot.

## 2026-09-20 One-liners

- `neonctl` and `vercel project ls` hang for minutes inside the agent shell; the REST APIs (`console.neon.tech/api/v2`, `api.vercel.com`) answer in under a second. Use them.
- A Neon org API key needs `org_id` on every project call; the org list is `GET /users/me/organizations`.
- `pnpm -w run build` is the way to run a root script from a Vercel root directory of `apps/web`.
- An agent left `apps/web/test/zz-scratch.test.tsx` writing to `C:/Users/.../Temp`; scratch probes belong in the scratchpad, never in `test/`.
