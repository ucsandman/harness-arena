import { deviceCodeRequestSchema, deviceCodeResponseSchema } from '@harness-arena/protocol';
import { createDeviceCode } from '@harness-arena/database';
import { apiError, apiJson, clientIp, enforceRateLimit, parseWith, readJsonBody } from '@/lib/api';
import { generateUserCode, randomToken, sha256 } from '@/lib/auth';
import { db } from '@/lib/db';
import { absoluteUrl } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** RFC 8628-style timings: the code is good for 15 minutes and the CLI polls every 5 seconds. */
const EXPIRES_IN_SECONDS = 900;
const POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ATTEMPTS = 5;

/**
 * Start a device login. Public and rate limited by IP. The long device code is returned to the CLI
 * and stored only as a sha256 hash; the short user code is what a human types into /device.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = enforceRateLimit('device-code', clientIp(request));
  if (limited) return limited;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(deviceCodeRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const deviceCode = randomToken(32);
  const expiresAt = new Date(Date.now() + EXPIRES_IN_SECONDS * 1000);
  const dbh = await db();

  let userCode: string | null = null;
  for (let attempt = 0; attempt < USER_CODE_ATTEMPTS && userCode === null; attempt++) {
    const candidate = generateUserCode();
    try {
      await createDeviceCode(dbh, {
        deviceCodeHash: sha256(deviceCode),
        userCode: candidate,
        deviceName: parsed.data.deviceName,
        expiresAt,
      });
      userCode = candidate;
    } catch {
      // the only unique columns are the two codes, so a collision is the plausible cause: try again
      userCode = null;
    }
  }
  if (userCode === null) {
    return apiError('server_error', 'could not allocate a user code; please retry');
  }

  const verificationUri = absoluteUrl('/device');
  const response = deviceCodeResponseSchema.parse({
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
    expiresIn: EXPIRES_IN_SECONDS,
    interval: POLL_INTERVAL_SECONDS,
  });
  return apiJson(response, 200);
}
