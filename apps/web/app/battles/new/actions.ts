'use server';

import { upsertBattleFromRecord } from '@harness-arena/database';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { battleLinks } from '@/lib/links';
import { specFromForm, type NewBattleState } from '@/lib/new-battle';
import { buildPendingRecord } from '@/lib/pending-battle';

/**
 * Validate the form into a BattleSpec and store it as a pending battle owned by the signed-in user.
 * Nothing is executed here: Arena never runs an agent on the server and never pays for model usage.
 */
export async function createBattleSpecAction(
  _previous: NewBattleState,
  form: FormData,
): Promise<NewBattleState> {
  const user = await getCurrentUser();
  if (!user) return { status: 'error', errors: ['Your session expired. Sign in again and resubmit.'] };

  const built = specFromForm(form);
  if (!built.ok) return { status: 'error', errors: built.errors };

  const record = buildPendingRecord(built.spec);
  const dbh = await db();
  await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: built.spec.visibility });

  return {
    status: 'created',
    errors: [],
    battleId: record.id,
    battleUrl: battleLinks(record.id).url,
    title: record.task.title,
  };
}
