/**
 * Read one challenge. Arena hosts no runner: a challenge is executed locally, with the arena CLI, by
 * whoever accepts it, and the battle is uploaded afterwards. A private challenge is visible only to
 * its creator and the account that accepted it.
 */
import { ARENA_EXECUTION_NOTE, challengeResponseSchema } from '@harness-arena/protocol';
import { getChallenge } from '@harness-arena/database';
import { apiError, apiJson, optionalViewer } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, ctx: Context): Promise<Response> {
  const { id } = await ctx.params;
  const viewer = await optionalViewer(request);

  const dbh = await db();
  const challenge = await getChallenge(dbh, id, viewer.userId);
  if (!challenge) return apiError('not_found', 'no challenge with that id is visible to you');

  return apiJson(
    challengeResponseSchema.parse({
      challenge,
      url: absoluteUrl('/challenges/' + id),
      note: ARENA_EXECUTION_NOTE,
    }),
  );
}
