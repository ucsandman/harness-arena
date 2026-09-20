/**
 * Cancel a challenge. Arena hosts no runner: cancelling simply withdraws the definition before anyone
 * runs it. Only the creator may cancel, and only before it completed.
 */
import { ARENA_EXECUTION_NOTE, challengeResponseSchema } from '@harness-arena/protocol';
import { cancelChallenge } from '@harness-arena/database';
import { apiError, apiJson, requireDevice, type ApiErrorCode } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

const CODE: Record<'not_found' | 'forbidden' | 'conflict', ApiErrorCode> = {
  not_found: 'not_found',
  forbidden: 'forbidden',
  conflict: 'invalid_request',
};

export async function POST(request: Request, ctx: Context): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const dbh = await db();
  const outcome = await cancelChallenge(dbh, id, auth.auth.user.id);
  if (!outcome.ok) return apiError(CODE[outcome.code], outcome.reason);

  return apiJson(
    challengeResponseSchema.parse({
      challenge: outcome.challenge,
      url: absoluteUrl('/challenges/' + id),
      note: ARENA_EXECUTION_NOTE,
    }),
  );
}
