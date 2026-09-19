'use server';

import { revalidatePath } from 'next/cache';
import { visibilitySchema } from '@harness-arena/protocol';
import { applyBattleToRatings, getBattle, setBattleVisibility } from '@harness-arena/database';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * Change who can see a battle. The owner check is the database query itself: `setBattleVisibility`
 * only updates a row whose owner_user_id matches, so a forged battle id changes nothing.
 */
export async function updateVisibilityAction(formData: FormData): Promise<void> {
  const id = String(formData.get('battleId') ?? '');
  const parsed = visibilitySchema.safeParse(formData.get('visibility'));
  if (!id || !parsed.success) return;

  const user = await getCurrentUser();
  if (!user) return;

  const dbh = await db();
  await setBattleVisibility(dbh, id, user.id, parsed.data);
  // Ratings move only on a public, completed, non-demo battle; idempotent per battle id, so a
  // battle that was already counted while public is not counted again.
  if (parsed.data === 'public') {
    const found = await getBattle(dbh, id);
    const record = found?.battle.record;
    if (record && record.status === 'completed' && !record.demo) await applyBattleToRatings(dbh, record);
  }
  revalidatePath(`/battles/${id}`);
  revalidatePath('/battles');
}
