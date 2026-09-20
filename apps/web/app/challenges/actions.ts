'use server';

import { revalidatePath } from 'next/cache';
import { cancelChallenge } from '@harness-arena/database';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * Withdraw a challenge. Only the creator can, and only before it completed: `cancelChallenge` checks
 * both and this action never assumes either. A refusal leaves the row untouched; the page re-renders
 * with the unchanged status rather than claiming something happened.
 */
export async function cancelChallengeAction(form: FormData): Promise<void> {
  const id = form.get('challengeId');
  if (typeof id !== 'string' || id.length === 0) return;
  const user = await getCurrentUser();
  if (!user) return;

  const dbh = await db();
  await cancelChallenge(dbh, id, user.id);
  revalidatePath(`/challenges/${id}`);
  revalidatePath('/challenges');
}
