/**
 * Bounty submissions: register an intent to compete. Arena runs no battle: the submitter runs the
 * work locally, with the arena CLI, and uploads the battles against this submission afterwards.
 */
import {
  ARENA_EXECUTION_NOTE,
  bountySubmissionListResponseSchema,
  bountySubmissionResponseSchema,
  createBountySubmissionRequestSchema,
} from '@harness-arena/protocol';
import { listBountySubmissions, submitToBounty } from '@harness-arena/database';
import { apiError, apiJson, parseWith, readJsonBody, requireDevice, type ApiErrorCode } from '@/lib/api';
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

/** Submissions to one bounty, newest first. Public read, no auth. */
export async function GET(_request: Request, ctx: Context): Promise<Response> {
  const { id } = await ctx.params;

  const dbh = await db();
  const submissions = await listBountySubmissions(dbh, id);
  return apiJson(
    bountySubmissionListResponseSchema.parse({
      submissions,
      count: submissions.length,
      note: ARENA_EXECUTION_NOTE,
    }),
  );
}

/** Register a submission. The caller runs the battles locally and uploads them against this id. */
export async function POST(request: Request, ctx: Context): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(createBountySubmissionRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const dbh = await db();
  const outcome = await submitToBounty(
    dbh,
    id,
    { harness: parsed.data.harness },
    { userId: auth.auth.user.id },
  );
  if (!outcome.ok) return apiError(CODE[outcome.code], outcome.reason);

  const response = bountySubmissionResponseSchema.parse({
    submission: outcome.value,
    url: absoluteUrl('/bounties/' + id),
    note: ARENA_EXECUTION_NOTE,
  });
  return apiJson(response, 201);
}
