/**
 * Challenges: "my harness against yours, on this task".
 *
 * Arena hosts no runner. A challenge is executed locally, with the arena CLI, by whoever accepts it,
 * and the battle is uploaded afterwards. The server stores the definition, verifies the competitors
 * and links the battle; every result is community-reported.
 */
import {
  ARENA_EXECUTION_NOTE,
  challengeListResponseSchema,
  challengeResponseSchema,
  challengeStatusSchema,
  createChallengeRequestSchema,
  type ChallengeStatus,
} from '@harness-arena/protocol';
import { createChallenge, listChallenges } from '@harness-arena/database';
import { apiError, apiJson, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function parseStatus(
  url: URL,
): { ok: true; value: ChallengeStatus | undefined } | { ok: false; response: Response } {
  const raw = url.searchParams.get('status');
  if (!raw) return { ok: true, value: undefined };
  const parsed = challengeStatusSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: apiError('invalid_request', `invalid status "${raw}"`) };
  return { ok: true, value: parsed.data };
}

/** Public challenges, newest first. Public read, no auth. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const status = parseStatus(url);
  if (!status.ok) return status.response;

  const limitParam = Number(url.searchParams.get('limit') ?? '');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined;

  const dbh = await db();
  const challenges = await listChallenges(dbh, {
    status: status.value,
    harnessSlug: url.searchParams.get('harness') ?? undefined,
    limit,
  });
  return apiJson(
    challengeListResponseSchema.parse({ challenges, count: challenges.length, note: ARENA_EXECUTION_NOTE }),
  );
}

/** Create a challenge. The caller becomes its creator; anyone (including the creator) may accept it. */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(createChallengeRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const dbh = await db();
  const challenge = await createChallenge(dbh, parsed.data, { createdByUserId: auth.auth.user.id });
  const response = challengeResponseSchema.parse({
    challenge,
    url: absoluteUrl('/challenges/' + challenge.id),
    note: ARENA_EXECUTION_NOTE,
  });
  return apiJson(response, 201);
}
