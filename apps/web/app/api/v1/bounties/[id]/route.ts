/**
 * Read one bounty and its submissions. Arena moves no money and runs no battle: a submitter runs the
 * work locally and uploads the battles afterwards; every result is community-reported.
 */
import { ARENA_EXECUTION_NOTE, bountyResponseSchema } from '@harness-arena/protocol';
import { getBounty, listBountySubmissions } from '@harness-arena/database';
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
  const bounty = await getBounty(dbh, id);
  if (!bounty) return apiError('not_found', 'no bounty with that id');

  const submissions = await listBountySubmissions(dbh, id);
  return apiJson(
    bountyResponseSchema.parse({
      bounty,
      submissions,
      url: absoluteUrl('/bounties/' + id),
      note: ARENA_EXECUTION_NOTE,
    }),
  );
}
