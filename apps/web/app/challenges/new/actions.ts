'use server';

import { redirect } from 'next/navigation';
import { createChallenge } from '@harness-arena/database';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { challengeFromForm, type NewArenaState } from '@/lib/arena-forms';

/**
 * Store a challenge definition owned by the signed-in user. Nothing runs here: Arena never executes
 * an agent on the server. Whoever accepts the challenge runs it with `arena challenge run <id>`.
 */
export async function createChallengeAction(
  _previous: NewArenaState,
  form: FormData,
): Promise<NewArenaState> {
  const user = await getCurrentUser();
  if (!user) return { status: 'error', errors: ['Your session expired. Sign in again and resubmit.'] };

  const built = challengeFromForm(form);
  if (!built.ok) return { status: 'error', errors: built.errors };

  const dbh = await db();
  const challenge = await createChallenge(dbh, built.request, { createdByUserId: user.id });
  redirect(`/challenges/${challenge.id}`);
}
