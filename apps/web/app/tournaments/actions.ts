'use server';

import { revalidatePath } from 'next/cache';
import { startTournament } from '@harness-arena/database';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * draft -> running. Only the creator opens their own bracket, and `startTournament` enforces that;
 * this action never assumes it. Starting changes nothing about who may play: any contributor runs
 * pending matches locally.
 */
export async function startTournamentAction(form: FormData): Promise<void> {
  const idOrSlug = form.get('tournamentId');
  if (typeof idOrSlug !== 'string' || idOrSlug.length === 0) return;
  const user = await getCurrentUser();
  if (!user) return;

  const dbh = await db();
  await startTournament(dbh, idOrSlug, user.id);
  revalidatePath(`/tournaments/${idOrSlug}`);
  revalidatePath('/tournaments');
}
