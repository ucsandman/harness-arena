const SESSION_TTL_SECONDS = 3600;

/**
 * A session stores `expiresAt` as a UNIX timestamp in SECONDS.
 */
export function createSession(userId, now = Date.now()) {
  return { userId, expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
}

export function isExpired(session, now = Date.now()) {
  return session.expiresAt <= now;
}
