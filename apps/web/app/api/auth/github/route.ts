import { NextResponse } from 'next/server';
import {
  GITHUB_AUTHORIZE_URL,
  GITHUB_SCOPE,
  OAUTH_NEXT_COOKIE,
  OAUTH_STATE_COOKIE,
  isSecureRequest,
  randomToken,
  stateCookieOptions,
} from '@/lib/auth';
import { absoluteUrl, githubOAuth } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Step 1 of the GitHub authorization-code flow: remember a random state in an httpOnly cookie and
 * hand the visitor to GitHub. No client secret is involved here, and nothing is logged.
 */
export function GET(request: Request): NextResponse {
  const oauth = githubOAuth();
  if (!oauth) return NextResponse.redirect(absoluteUrl('/login?error=not_configured'));

  const state = randomToken(16);
  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', oauth.clientId);
  authorize.searchParams.set('redirect_uri', absoluteUrl('/api/auth/github/callback'));
  authorize.searchParams.set('scope', GITHUB_SCOPE);
  authorize.searchParams.set('state', state);

  const response = NextResponse.redirect(authorize.toString());
  const options = stateCookieOptions(isSecureRequest(request));
  response.cookies.set(OAUTH_STATE_COOKIE, state, options);

  // only an in-app destination is ever carried across the round trip
  const next = new URL(request.url).searchParams.get('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) {
    response.cookies.set(OAUTH_NEXT_COOKIE, next, options);
  }
  return response;
}
