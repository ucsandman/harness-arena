import { ingestEventsRequestSchema, ingestEventsResponseSchema } from '@harness-arena/protocol';
import { insertEvents } from '@harness-arena/database';
import { apiError, apiJson, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { ownedBattle } from '@/lib/battles';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Append a batch of events. Duplicate (battle, seq) pairs are ignored by the database, so a retried
 * upload is a no-op and shows up as `rejected`. Invalid events never reach here: zod rejects the batch.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(ingestEventsRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const foreign = parsed.data.events.find((event) => event.battleId !== id);
  if (foreign) return apiError('invalid_request', 'every event must carry the battleId in the path');

  const dbh = await db();
  const owned = await ownedBattle(dbh, id, auth.auth.user.id);
  if (!owned.ok) {
    return owned.code === 'not_found'
      ? apiError('not_found', 'no battle with that id')
      : apiError('forbidden', 'that battle belongs to another account');
  }

  const result = await insertEvents(dbh, id, parsed.data.events);
  return apiJson(ingestEventsResponseSchema.parse(result));
}
