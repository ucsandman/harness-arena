import {
  createBattleRequestSchema,
  createBattleResponseSchema,
  type BattleRecord,
  type Visibility,
} from '@harness-arena/protocol';
import {
  afterBattleUpsert,
  applyBattleToRatings,
  getBattle,
  listUserBattles,
  upsertBattleFromRecord,
} from '@harness-arena/database';
import { apiError, apiJson, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { clampSelfReported } from '@/lib/battles';
import { db } from '@/lib/db';
import { battleLinks } from '@/lib/links';
import { buildPendingRecord } from '@/lib/pending-battle';

export const dynamic = 'force-dynamic';

/** The caller's battles, newest first, private ones included. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const limitParam = Number(new URL(request.url).searchParams.get('limit') ?? '');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;

  const dbh = await db();
  const battles = await listUserBattles(dbh, auth.auth.user.id, limit);
  return apiJson({ battles, count: battles.length });
}

/**
 * Create or replace a battle. `record` is authoritative and converges on re-upload; `spec` alone
 * creates a pending battle that the user then runs locally with `arena run --battle <id>`.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(createBattleRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const { record: uploaded, spec, visibility: requested } = parsed.data;
  if (!uploaded && !spec) {
    return apiError('invalid_request', 'provide a record, a spec, or both');
  }

  const record: BattleRecord = clampSelfReported(
    uploaded ?? buildPendingRecord(spec as NonNullable<typeof spec>),
  );
  const visibility: Visibility = requested ?? record.spec.visibility;

  const dbh = await db();
  const existing = await getBattle(dbh, record.id);
  if (existing && existing.battle.ownerUserId !== auth.auth.user.id) {
    return apiError('forbidden', 'that battle id belongs to another account');
  }

  const upserted = await upsertBattleFromRecord(dbh, {
    record,
    ownerUserId: auth.auth.user.id,
    deviceId: auth.auth.device.id,
    visibility,
  });
  await afterBattleUpsert(
    dbh,
    record,
    { a: { harnessId: upserted.harnessIds.a }, b: { harnessId: upserted.harnessIds.b } },
    { ownerUserId: auth.auth.user.id },
  );
  // ratings move on a public, completed, non-demo battle only: a private result has nothing to audit
  if (visibility === 'public' && record.status === 'completed' && !record.demo) {
    await applyBattleToRatings(dbh, record);
  }

  const response = createBattleResponseSchema.parse(battleLinks(record.id));
  return apiJson(response, existing ? 200 : 201);
}
