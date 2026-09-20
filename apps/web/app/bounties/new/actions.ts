'use server';

import { redirect } from 'next/navigation';
import { createBounty } from '@harness-arena/database';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { bountyFromForm, type NewArenaState } from '@/lib/arena-forms';

/**
 * Store a bounty definition. Arena moves no money: the reward is reputation or something the poster
 * settles elsewhere, and nothing here escrows, holds or transfers anything.
 */
export async function createBountyAction(
  _previous: NewArenaState,
  form: FormData,
): Promise<NewArenaState> {
  const user = await getCurrentUser();
  if (!user) return { status: 'error', errors: ['Your session expired. Sign in again and resubmit.'] };

  const built = bountyFromForm(form);
  if (!built.ok) return { status: 'error', errors: built.errors };

  const dbh = await db();
  const bounty = await createBounty(dbh, built.request, { createdByUserId: user.id });
  redirect(`/bounties/${bounty.id}`);
}
