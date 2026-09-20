'use server';

import { redirect } from 'next/navigation';
import { createTournament } from '@harness-arena/database';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { tournamentFromForm, type NewArenaState } from '@/lib/arena-forms';

/**
 * Build the bracket: seed the entrants from the community ratings they already hold and write every
 * match slot up front. No match is run here; `arena tournament play <id>` does that locally.
 */
export async function createTournamentAction(
  _previous: NewArenaState,
  form: FormData,
): Promise<NewArenaState> {
  const user = await getCurrentUser();
  if (!user) return { status: 'error', errors: ['Your session expired. Sign in again and resubmit.'] };

  const built = tournamentFromForm(form);
  if (!built.ok) return { status: 'error', errors: built.errors };

  const dbh = await db();
  const tournament = await createTournament(dbh, built.request, { createdByUserId: user.id });
  redirect(`/tournaments/${tournament.slug}`);
}
