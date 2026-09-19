'use server';

import { redirect } from 'next/navigation';
import { approveDeviceCode, denyDeviceCode, getDeviceCodeByUserCode } from '@harness-arena/database';
import { getCurrentUser, normalizeUserCode } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * The browser half of the device login. Approving links the code to the signed-in account; the CLI's
 * next poll receives the token (once). Nothing here ever sees or returns the device token itself.
 */

export type DeviceDecision = 'approved' | 'denied';

async function decide(formData: FormData, decision: DeviceDecision): Promise<void> {
  const code = normalizeUserCode(String(formData.get('userCode') ?? ''));
  if (code.length === 0) redirect('/device?error=missing');

  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/device?code=${code}`)}`);

  const dbh = await db();
  const row = await getDeviceCodeByUserCode(dbh, code);
  if (!row) redirect(`/device?error=unknown&code=${encodeURIComponent(code)}`);
  if (row.status !== 'pending' || row.expiresAt.getTime() <= Date.now()) {
    redirect(`/device?error=stale&code=${encodeURIComponent(code)}`);
  }

  const result =
    decision === 'approved'
      ? await approveDeviceCode(dbh, row.id, user.id)
      : await denyDeviceCode(dbh, row.id);
  if (!result) redirect(`/device?error=stale&code=${encodeURIComponent(code)}`);
  redirect(`/device?done=${decision}`);
}

export async function approveDeviceAction(formData: FormData): Promise<void> {
  await decide(formData, 'approved');
}

export async function denyDeviceAction(formData: FormData): Promise<void> {
  await decide(formData, 'denied');
}
