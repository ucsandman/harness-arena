import { NextResponse } from 'next/server';
import { upsertGithubUser } from '@harness-arena/database';
import {
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  OAUTH_NEXT_COOKIE,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  isSecureRequest,
  issueSession,
  readCookie,
  sessionCookieOptions,
  stateCookieOptions,
} from '@/lib/auth';
import { db } from '@/lib/db';
import { absoluteUrl, githubOAuth } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** Failures come back to /login with a code the page explains in words; never a stack trace. */
type CallbackError = 'not_configured' | 'denied' | 'invalid_state' | 'exchange_failed' | 'profile_failed';

function failure(request: Request, error: CallbackError): NextResponse {
  const response = NextResponse.redirect(absoluteUrl(`/login?error=${error}`));
  clearFlowCookies(response, request);
  return response;
}

function clearFlowCookies(response: NextResponse, request: Request): void {
  const options = { ...stateCookieOptions(isSecureRequest(request)), maxAge: 0 };
  response.cookies.set(OAUTH_STATE_COOKIE, '', options);
  response.cookies.set(OAUTH_NEXT_COOKIE, '', options);
}

interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
}

async function exchangeCode(code: string, clientId: string, clientSecret: string): Promise<string | null> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: absoluteUrl('/api/auth/github/callback'),
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: unknown };
  return typeof body.access_token === 'string' && body.access_token.length > 0 ? body.access_token : null;
}

async function fetchProfile(accessToken: string): Promise<GithubProfile | null> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'harness-arena',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    id?: unknown;
    login?: unknown;
    name?: unknown;
    avatar_url?: unknown;
    email?: unknown;
  };
  if (typeof body.id !== 'number' || typeof body.login !== 'string') return null;
  return {
    id: body.id,
    login: body.login,
    name: typeof body.name === 'string' ? body.name : null,
    avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null,
    email: typeof body.email === 'string' ? body.email : null,
  };
}

/**
 * Step 2: verify the state cookie, exchange the code for an access token, read the GitHub profile,
 * and create a session. The access token is used once here and never stored.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const oauth = githubOAuth();
  if (!oauth) return failure(request, 'not_configured');

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = readCookie(request, OAUTH_STATE_COOKIE);

  if (url.searchParams.get('error')) return failure(request, 'denied');
  if (!code || !state || !expected || state !== expected) return failure(request, 'invalid_state');

  const accessToken = await exchangeCode(code, oauth.clientId, oauth.clientSecret);
  if (!accessToken) return failure(request, 'exchange_failed');

  const profile = await fetchProfile(accessToken);
  if (!profile) return failure(request, 'profile_failed');

  const dbh = await db();
  const user = await upsertGithubUser(dbh, {
    githubId: profile.id,
    login: profile.login,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    email: profile.email,
  });
  const session = await issueSession(user.id, request.headers.get('user-agent'));

  const next = readCookie(request, OAUTH_NEXT_COOKIE);
  const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  const response = NextResponse.redirect(absoluteUrl(destination));
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(isSecureRequest(request)));
  clearFlowCookies(response, request);
  return response;
}
