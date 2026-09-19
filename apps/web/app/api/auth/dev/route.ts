import { NextResponse } from 'next/server';
import { upsertGithubUser } from '@harness-arena/database';
import { SESSION_COOKIE, isSecureRequest, issueSession, sessionCookieOptions } from '@/lib/auth';
import { db } from '@/lib/db';
import { absoluteUrl, devLoginEnabled } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** The local dev user: githubId 0, login "dev". Never a real GitHub account. */
const DEV_USER = { githubId: 0, login: 'dev', name: 'Local dev user' } as const;

/**
 * Sign in without a GitHub OAuth app. Exists only when ARENA_DEV_LOGIN=1 and NODE_ENV is not
 * production; in production this route answers 404 like any unknown path.
 */
export async function POST(request: Request): Promise<NextResponse | Response> {
  if (!devLoginEnabled()) return new Response('Not found', { status: 404 });

  const dbh = await db();
  const user = await upsertGithubUser(dbh, {
    githubId: DEV_USER.githubId,
    login: DEV_USER.login,
    name: DEV_USER.name,
    avatarUrl: null,
    email: null,
  });
  const session = await issueSession(user.id, request.headers.get('user-agent'));

  let destination = '/dashboard';
  try {
    const form = await request.formData();
    const next = form.get('next');
    if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) destination = next;
  } catch {
    // no form body (a plain POST from curl): the dashboard is the default destination
  }

  const response = NextResponse.redirect(absoluteUrl(destination), { status: 303 });
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(isSecureRequest(request)));
  return response;
}
