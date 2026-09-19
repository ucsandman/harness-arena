'use server';

import { revalidatePath } from 'next/cache';
import { revokeDevice } from '@harness-arena/database';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** Revoke one CLI token. The query is scoped to the signed-in user, so an id alone proves nothing. */
export async function revokeDeviceAction(formData: FormData): Promise<void> {
  const deviceId = String(formData.get('deviceId') ?? '');
  if (!deviceId) return;

  const user = await getCurrentUser();
  if (!user) return;

  const dbh = await db();
  await revokeDevice(dbh, user.id, deviceId);
  revalidatePath('/settings');
  revalidatePath('/dashboard');
}
