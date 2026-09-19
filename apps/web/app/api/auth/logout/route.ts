import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE,
  isSecureRequest,
  readCookie,
  revokeSessionToken,
  sessionCookieOptions,
} from '@/lib/auth';
import { absoluteUrl } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** Deletes the session row and clears the cookie, then returns to the landing page. */
export async function POST(request: Request): Promise<NextResponse> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await revokeSessionToken(token);
  const response = NextResponse.redirect(absoluteUrl('/'), { status: 303 });
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(isSecureRequest(request)), maxAge: 0 });
  return response;
}
