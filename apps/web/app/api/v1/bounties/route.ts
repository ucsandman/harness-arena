/**
 * Bounties: "beat this baseline on this task and I will say so publicly". Arena moves no money and
 * runs no battle. A submitter runs the work locally, with the arena CLI, and uploads the battles
 * against their submission afterwards; every result is community-reported.
 */
import {
  ARENA_EXECUTION_NOTE,
  bountyListResponseSchema,
  bountyResponseSchema,
  bountyStatusSchema,
  createBountyRequestSchema,
  type BountyStatus,
} from '@harness-arena/protocol';
import { createBounty, listBounties } from '@harness-arena/database';
import { apiError, apiJson, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { absoluteUrl } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function parseStatus(
  url: URL,
): { ok: true; value: BountyStatus | undefined } | { ok: false; response: Response } {
  const raw = url.searchParams.get('status');
  if (!raw) return { ok: true, value: undefined };
  const parsed = bountyStatusSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: apiError('invalid_request', `invalid status "${raw}"`) };
  return { ok: true, value: parsed.data };
}

/** Public bounties, newest first. Public read, no auth. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const status = parseStatus(url);
  if (!status.ok) return status.response;

  const limitParam = Number(url.searchParams.get('limit') ?? '');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined;

  const dbh = await db();
  const bounties = await listBounties(dbh, { status: status.value, limit });
  return apiJson(
    bountyListResponseSchema.parse({ bounties, count: bounties.length, note: ARENA_EXECUTION_NOTE }),
  );
}

/** Post a bounty. The caller becomes its creator; only they may close or award it. */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(createBountyRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const dbh = await db();
  const bounty = await createBounty(dbh, parsed.data, { createdByUserId: auth.auth.user.id });
  const response = bountyResponseSchema.parse({
    bounty,
    submissions: [],
    url: absoluteUrl('/bounties/' + bounty.id),
    note: ARENA_EXECUTION_NOTE,
  });
  return apiJson(response, 201);
}
