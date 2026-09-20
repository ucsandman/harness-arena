/**
 * Single-elimination tournaments. Arena hosts no runner: `arena tournament play <id>` runs the pending
 * matches on a contributor's machine and uploads them afterwards. The server seeds the bracket from
 * community ratings and links each uploaded battle to the slot it claims.
 */
import {
  ARENA_EXECUTION_NOTE,
  createTournamentRequestSchema,
  tournamentListResponseSchema,
  tournamentResponseSchema,
  tournamentStatusSchema,
  type TournamentStatus,
} from '@harness-arena/protocol';
import { createTournament, listTournaments } from '@harness-arena/database';
import { apiError, apiJson, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function parseStatus(
  url: URL,
): { ok: true; value: TournamentStatus | undefined } | { ok: false; response: Response } {
  const raw = url.searchParams.get('status');
  if (!raw) return { ok: true, value: undefined };
  const parsed = tournamentStatusSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: apiError('invalid_request', `invalid status "${raw}"`) };
  return { ok: true, value: parsed.data };
}

/** Public tournaments, newest first. Public read, no auth. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const status = parseStatus(url);
  if (!status.ok) return status.response;

  const limitParam = Number(url.searchParams.get('limit') ?? '');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined;

  const dbh = await db();
  const tournaments = await listTournaments(dbh, { status: status.value, limit });
  return apiJson(
    tournamentListResponseSchema.parse({
      tournaments,
      count: tournaments.length,
      note: ARENA_EXECUTION_NOTE,
    }),
  );
}

/** Create a tournament as a draft. Only the creator may start it. */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(createTournamentRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const dbh = await db();
  const tournament = await createTournament(dbh, parsed.data, { createdByUserId: auth.auth.user.id });
  const response = tournamentResponseSchema.parse({
    tournament,
    url: absoluteUrl('/tournaments/' + tournament.slug),
    note: ARENA_EXECUTION_NOTE,
  });
  return apiJson(response, 201);
}
