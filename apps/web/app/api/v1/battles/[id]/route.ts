import {
  battleRecordSchema,
  patchBattleRequestSchema,
  type BattleRecord,
  battleDetailResponseSchema,
} from '@harness-arena/protocol';
import {
  applyBattleToRatings,
  countEvents,
  getBattleForViewer,
  setBattleVisibility,
  upsertBattleFromRecord,
} from '@harness-arena/database';
import { apiError, apiJson, optionalViewer, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { MAX_PAGE_EVENTS, clampSelfReported, loadEvents, ownedBattle } from '@/lib/battles';
import { db } from '@/lib/db';
import { battleLinks } from '@/lib/links';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * Read a battle. Visibility decides: private battles need the owner (session or device token),
 * unlisted and public are readable by anyone with the link. `?events=1` appends the event log,
 * `?format=json` returns the record as a download.
 */
export async function GET(request: Request, ctx: Context): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const viewer = await optionalViewer(request);

  const dbh = await db();
  const found = await getBattleForViewer(dbh, id, viewer.userId);
  if (!found) return apiError('not_found', 'no battle with that id is visible to you');

  const record = found.battle.record;
  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify(record, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${id}.json"`,
        'cache-control': 'no-store',
      },
    });
  }

  const total = await countEvents(dbh, id);
  if (url.searchParams.get('events') !== '1') {
    return apiJson(
      battleDetailResponseSchema.parse({
        record,
        eventCount: total,
        eventsCapped: found.battle.eventsCapped,
      }),
    );
  }

  // an absent (or empty) ?after= must not read as 0, which would drop the event with seq 0
  const afterRaw = url.searchParams.get('after');
  const afterParam = afterRaw === null || afterRaw === '' ? Number.NaN : Number(afterRaw);
  const afterSeq = Number.isFinite(afterParam) && afterParam >= 0 ? Math.floor(afterParam) : undefined;
  const loaded = await loadEvents(dbh, id, {
    cap: MAX_PAGE_EVENTS,
    ...(afterSeq === undefined ? {} : { afterSeq }),
  });
  return apiJson(
    battleDetailResponseSchema.parse({
      record,
      events: loaded.events,
      eventCount: total,
      eventsCapped: found.battle.eventsCapped,
      truncated: loaded.capped,
      invalid: loaded.invalid,
    }),
  );
}

/** Patch a battle the caller owns: a new record, a status change, or a visibility change. */
export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(patchBattleRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;
  const patch = parsed.data;
  if (!patch.record && !patch.status && !patch.visibility) {
    return apiError('invalid_request', 'nothing to patch: send a record, a status, or a visibility');
  }
  if (patch.record && patch.record.id !== id) {
    return apiError('invalid_request', 'the record id does not match the battle in the path');
  }

  const dbh = await db();
  const owned = await ownedBattle(dbh, id, auth.auth.user.id);
  if (!owned.ok) {
    return owned.code === 'not_found'
      ? apiError('not_found', 'no battle with that id')
      : apiError('forbidden', 'that battle belongs to another account');
  }

  const base: BattleRecord = patch.record ? clampSelfReported(patch.record) : owned.battle.record;
  const next: BattleRecord = patch.status
    ? battleRecordSchema.parse({ ...base, status: patch.status })
    : base;
  const visibility = patch.visibility ?? owned.battle.visibility;

  await upsertBattleFromRecord(dbh, {
    record: next,
    ownerUserId: auth.auth.user.id,
    deviceId: auth.auth.device.id,
    visibility,
  });
  if (patch.visibility) await setBattleVisibility(dbh, id, auth.auth.user.id, patch.visibility);
  // ratings move on a public, completed, non-demo battle only, so publishing is what counts it
  if (visibility === 'public' && next.status === 'completed' && !next.demo) {
    await applyBattleToRatings(dbh, next);
  }

  return apiJson({ ...battleLinks(id), status: next.status, visibility });
}
