import type { ZodType } from 'zod';
import { API_LIMITS, apiErrorSchema } from '@harness-arena/protocol';
import { getDeviceByTokenHash, type Device, type User } from '@harness-arena/database';
import { getRequestUser, sha256 } from './auth';
import { db } from './db';
import { describeIssues } from './issues';

/**
 * Shared plumbing for /api/v1: bearer authentication with device tokens, a fixed-window rate limiter,
 * a body size guard, and one error shape (apiErrorSchema). Clients never receive a stack trace, and
 * no token, header or body is ever logged.
 */

export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'payload_too_large'
  | 'rate_limited'
  | 'server_error';

const STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  payload_too_large: 413,
  rate_limited: 429,
  server_error: 500,
};

const MAX_MESSAGE_LENGTH = 400;

export function apiError(code: ApiErrorCode, message: string, headers?: HeadersInit): Response {
  const body = apiErrorSchema.parse({ error: { code, message: message.slice(0, MAX_MESSAGE_LENGTH) } });
  return Response.json(body, { status: STATUS[code], headers });
}

export function apiJson(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

export function parseWith<T>(schema: ZodType<T>, value: unknown): Parsed<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, response: apiError('invalid_request', describeIssues(result.error)) };
}

// ---- rate limiting ----------------------------------------------------------------------------

/**
 * Fixed window, in process memory. On a serverless host this is per instance, so it is a courtesy
 * limit rather than a guarantee; a durable limiter (Redis, or Postgres counters) is the later step
 * that would make it exact.
 */
export const RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;

/**
 * Ceiling for callers this deployment cannot identify (no trusted proxy in front of it, so
 * `x-forwarded-for` is ignored). They share one window per scope, deliberately wider than the
 * per-client limit: a dozen honest `arena login` sessions polling at once must not lock each other
 * out, while a forged header still cannot buy a fresh window.
 */
export const SHARED_RATE_LIMIT_MAX = 1200;

interface FixedWindow {
  count: number;
  resetAt: number;
}

const windows = new Map<string, FixedWindow>();
const MAX_TRACKED_KEYS = 20_000;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(key: string, now = Date.now(), max: number = RATE_LIMIT.max): RateLimitResult {
  if (windows.size > MAX_TRACKED_KEYS) {
    for (const [tracked, window] of windows) {
      if (window.resetAt <= now) windows.delete(tracked);
    }
  }
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return { ok: true, remaining: max - 1, retryAfterSeconds: 0 };
  }
  current.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  if (current.count > max) return { ok: false, remaining: 0, retryAfterSeconds };
  return { ok: true, remaining: max - current.count, retryAfterSeconds };
}

/** Drops all windows. Used by tests and after a deploy; never on a request path. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * How many reverse proxies in front of this app append to `x-forwarded-for`
 * (`ARENA_TRUSTED_PROXY_HOPS`). 0, the default, means the header is client-supplied and is ignored
 * entirely, so nobody can mint a fresh rate-limit window by sending one.
 */
function trustedProxyHops(): number {
  const hops = Number(process.env.ARENA_TRUSTED_PROXY_HOPS ?? '');
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
}

/**
 * The caller's address, or null when this deployment has no trustworthy way to know it. Only the hop
 * the configured proxy chain actually wrote is read (the last entry for one proxy), so a forged
 * prefix in `x-forwarded-for` never becomes the identity.
 */
export function clientIp(request: Request, hops = trustedProxyHops()): string | null {
  if (hops <= 0) return null;
  const chain = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const forwarded = chain[chain.length - hops];
  if (forwarded) return forwarded;
  return request.headers.get('x-real-ip')?.trim() || null;
}

/**
 * A 429 response when the caller is over the limit, otherwise null. A null identity is a caller this
 * deployment cannot identify: those share one wide window per scope (SHARED_RATE_LIMIT_MAX) instead
 * of one per-client-sized window for the whole internet.
 */
export function enforceRateLimit(scope: string, identity: string | null): Response | null {
  const result =
    identity === null
      ? rateLimit(`${scope}:shared`, Date.now(), SHARED_RATE_LIMIT_MAX)
      : rateLimit(`${scope}:${identity}`);
  if (result.ok) return null;
  return apiError('rate_limited', `too many requests; retry in ${result.retryAfterSeconds}s`, {
    'retry-after': String(result.retryAfterSeconds),
  });
}

// ---- body -------------------------------------------------------------------------------------

function tooLarge(): Response {
  const limitMb = (API_LIMITS.maxBodyBytes / (1024 * 1024)).toFixed(0);
  return apiError('payload_too_large', `request body exceeds the ${limitMb} MB limit`);
}

class BodyTooLarge extends Error {}

/**
 * Reads the body stream, stopping as soon as the running byte count passes the cap and cancelling
 * the reader so the rest of the upload is torn down instead of buffered. A chunked request declares
 * no length, so this is the only place the limit can actually be enforced.
 */
async function readCappedText(request: Request, cap: number): Promise<string> {
  const body = request.body;
  if (!body) return request.text();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > cap) throw new BodyTooLarge();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already finished or destroyed by the client
    }
  }
  return text + decoder.decode();
}

/** Reads a JSON body, refusing anything over API_LIMITS.maxBodyBytes by header and while reading. */
export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > API_LIMITS.maxBodyBytes) {
    return { ok: false, response: tooLarge() };
  }
  let text: string;
  try {
    text = await readCappedText(request, API_LIMITS.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLarge) return { ok: false, response: tooLarge() };
    return { ok: false, response: apiError('invalid_request', 'request body could not be read') };
  }
  if (text.trim().length === 0) {
    return { ok: false, response: apiError('invalid_request', 'request body is empty') };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: apiError('invalid_request', 'request body is not valid JSON') };
  }
}

// ---- bearer authentication --------------------------------------------------------------------

export interface AuthenticatedDevice {
  device: Device;
  user: User;
}

export type DeviceAuth = { ok: true; auth: AuthenticatedDevice } | { ok: false; response: Response };

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Authenticate a CLI device token. Applies the per-IP and per-token rate limit first, so every
 * bearer route is limited by construction.
 */
export async function requireDevice(request: Request): Promise<DeviceAuth> {
  const token = bearerToken(request);
  if (!token) {
    return {
      ok: false,
      response: apiError('unauthorized', 'missing Authorization: Bearer <device token>', {
        'www-authenticate': 'Bearer',
      }),
    };
  }
  const tokenHash = sha256(token);
  const ipLimited = enforceRateLimit('ip', clientIp(request));
  if (ipLimited) return { ok: false, response: ipLimited };
  const tokenLimited = enforceRateLimit('token', tokenHash);
  if (tokenLimited) return { ok: false, response: tokenLimited };

  const dbh = await db();
  const found = await getDeviceByTokenHash(dbh, tokenHash);
  if (!found) {
    return {
      ok: false,
      response: apiError('unauthorized', 'unknown or revoked device token; run "arena login" again', {
        'www-authenticate': 'Bearer',
      }),
    };
  }
  return { ok: true, auth: { device: found.device, user: found.user } };
}

// ---- optional viewer identity ------------------------------------------------------------------

export interface Viewer {
  userId: string | null;
  deviceId: string | null;
}

/**
 * Who is asking, when authentication is optional: a CLI device token if one is presented, otherwise
 * the browser session, otherwise nobody. Used by every read that is gated on visibility.
 */
export async function optionalViewer(request: Request): Promise<Viewer> {
  const token = bearerToken(request);
  const dbh = await db();
  if (token) {
    const found = await getDeviceByTokenHash(dbh, sha256(token));
    return { userId: found?.user.id ?? null, deviceId: found?.device.id ?? null };
  }
  const user = await getRequestUser(request);
  return { userId: user?.id ?? null, deviceId: null };
}
