/**
 * Read one tournament, by id or by slug. Arena hosts no runner: matches are played locally with the
 * arena CLI and uploaded afterwards.
 */
import { ARENA_EXECUTION_NOTE, tournamentResponseSchema } from '@harness-arena/protocol';
import { getTournament } from '@harness-arena/database';
import { apiError, apiJson } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, ctx: Context): Promise<Response> {
  const { id } = await ctx.params;

  const dbh = await db();
  const tournament = await getTournament(dbh, id);
  if (!tournament) return apiError('not_found', 'no tournament with that id or slug');

  return apiJson(
    tournamentResponseSchema.parse({
      tournament,
      url: absoluteUrl('/tournaments/' + tournament.slug),
      note: ARENA_EXECUTION_NOTE,
    }),
  );
}
