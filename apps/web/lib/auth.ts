import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSession, deleteSession, getSessionUser, type User } from '@harness-arena/database';
import { db } from './db';

/**
 * GitHub OAuth authorization-code flow and server-side sessions, implemented directly (no auth
 * library). Nothing secret is ever stored in plain text: the session cookie value and every device
 * token are kept only as sha256 hashes, and no token value is ever logged.
 */

export const SESSION_COOKIE = 'arena_session';
export const OAUTH_STATE_COOKIE = 'arena_oauth_state';
export const OAUTH_NEXT_COOKIE = 'arena_oauth_next';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';
export const GITHUB_SCOPE = 'read:user user:email';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 32 random bytes as hex: session cookies, OAuth state, and the CLI device code. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** No I, O, 0 or 1: a code read off a terminal and typed into a browser cannot be misread. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateUserCode(): string {
  const source = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[(source[i] as number) % USER_CODE_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Accepts "abcd1234", "abcd-1234" or " ABCD-1234 " and returns the canonical "ABCD-1234". */
export function normalizeUserCode(input: string): string {
  const compact = (input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length !== 8) return compact;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export const DEVICE_TOKEN_PREFIX = 'arena_dev_';

export interface DeviceTokenParts {
  token: string;
  tokenHash: string;
  /** first 8 characters of the random part, so the account page can tell two tokens apart */
  tokenPrefix: string;
}

export function generateDeviceToken(): DeviceTokenParts {
  const random = randomBytes(20).toString('hex');
  const token = `${DEVICE_TOKEN_PREFIX}${random}`;
  return { token, tokenHash: sha256(token), tokenPrefix: random.slice(0, 8) };
}

// ---- cookies ----------------------------------------------------------------------------------

/** Read one cookie straight off a Request, so route handlers work without a Next request scope. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/** https behind a proxy (x-forwarded-proto) or directly. Decides the cookie `secure` flag. */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim() === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface CookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}

export function sessionCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

export function stateCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: OAUTH_STATE_TTL_SECONDS };
}

// ---- sessions ---------------------------------------------------------------------------------

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/** Create a session row for `userId` and return the raw cookie value (stored only as a hash). */
export async function issueSession(userId: string, userAgent?: string | null): Promise<IssuedSession> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const dbh = await db();
  await createSession(dbh, userId, sha256(token), expiresAt, userAgent ?? null);
  return { token, expiresAt };
}

export async function revokeSessionToken(token: string): Promise<boolean> {
  const dbh = await db();
  return deleteSession(dbh, sha256(token));
}

/** The signed-in user of a plain Request (session cookie only; API routes handle bearer separately). */
export async function getRequestUser(request: Request): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const dbh = await db();
  const found = await getSessionUser(dbh, sha256(token));
  return found?.user ?? null;
}

/** The session cookie inside a server component or server action. */
export async function readSessionCookie(): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(SESSION_COOKIE)?.value ?? null;
  } catch {
    // no request scope (unit tests, static rendering): there is no cookie to read
    return null;
  }
}

export async function getCurrentUser(): Promise<User | null> {
  const token = await readSessionCookie();
  if (!token) return null;
  const dbh = await db();
  const found = await getSessionUser(dbh, sha256(token));
  return found?.user ?? null;
}

/** For pages that require an account: sends the visitor to /login and back again afterwards. */
export async function requireUser(next: string): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}
