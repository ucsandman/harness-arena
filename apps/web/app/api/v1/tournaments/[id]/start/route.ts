/**
 * Start a tournament: draft -> running. Arena hosts no runner: starting only opens the bracket for
 * play, `arena tournament play <id>` runs the pending matches locally afterwards. Only the creator may
 * start their own tournament.
 */
import { ARENA_EXECUTION_NOTE, tournamentResponseSchema } from '@harness-arena/protocol';
import { startTournament } from '@harness-arena/database';
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
  const outcome = await startTournament(dbh, id, auth.auth.user.id);
  if (!outcome.ok) return apiError(CODE[outcome.code], outcome.reason);

  return apiJson(
    tournamentResponseSchema.parse({
      tournament: outcome.tournament,
      url: absoluteUrl('/tournaments/' + outcome.tournament.slug),
      note: ARENA_EXECUTION_NOTE,
    }),
  );
}
