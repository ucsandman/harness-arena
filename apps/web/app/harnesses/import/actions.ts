'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { inspectToken } from '@/lib/env';
import { inspectGithubHarness, saveHarness } from '@/lib/harness-import';

/**
 * Saving re-inspects the repository over the GitHub API instead of trusting anything the browser
 * posted back, so a forged inspection payload cannot enter the catalog.
 */
export async function saveHarnessAction(formData: FormData): Promise<void> {
  const url = String(formData.get('url') ?? '').trim();
  if (!url) redirect('/harnesses/import?error=invalid_url');

  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/harnesses/import?url=${url}`)}`);

  const result = await inspectGithubHarness({ url, token: inspectToken() });
  if (!result.ok) {
    redirect(`/harnesses/import?url=${encodeURIComponent(url)}&error=${result.code}`);
  }

  const dbh = await db();
  const saved = await saveHarness(dbh, {
    inspection: result.inspection,
    url: result.url,
    name: `${result.owner}/${result.repo}`,
    ownerUserId: user.id,
  });

  revalidatePath('/harnesses');
  redirect(`/harnesses/${saved.slug}?saved=1`);
}
