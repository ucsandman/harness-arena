import {
  deviceTokenRequestSchema,
  deviceTokenResponseSchema,
  type DeviceTokenResponse,
} from '@harness-arena/protocol';
import { createDevice, getDeviceCodeByHash, getUserById } from '@harness-arena/database';
import { apiError, apiJson, clientIp, enforceRateLimit, parseWith, readJsonBody } from '@/lib/api';
import { generateDeviceToken, sha256 } from '@/lib/auth';
import { codeAlreadyConsumed, scopesForDevice } from '@/lib/device';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function status(value: 'pending' | 'denied' | 'expired'): Response {
  const body: DeviceTokenResponse = deviceTokenResponseSchema.parse({ status: value });
  return apiJson(body, 200);
}

/**
 * The CLI polls here while the browser approves. An approved code yields a token exactly once: the
 * issued device records the code id, and a second poll answers `expired` rather than minting again.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = enforceRateLimit('device-token', clientIp(request));
  if (limited) return limited;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(deviceTokenRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const dbh = await db();
  const code = await getDeviceCodeByHash(dbh, sha256(parsed.data.deviceCode));
  if (!code) return apiError('not_found', 'unknown device code; start a new login');

  const expired = code.expiresAt.getTime() <= Date.now();
  if (code.status === 'denied') return status('denied');
  // an approval does not outlive the code: a stale device code read off a log is never redeemable
  if (code.status === 'expired' || expired) return status('expired');
  if (code.status === 'pending') return status('pending');

  // approved
  if (!code.userId) return apiError('server_error', 'approved device code has no account attached');
  if (await codeAlreadyConsumed(dbh, code)) return status('expired');

  const user = await getUserById(dbh, code.userId);
  if (!user) return apiError('server_error', 'the approving account no longer exists');

  const token = generateDeviceToken();
  const device = await createDevice(dbh, {
    userId: user.id,
    name: code.deviceName,
    tokenHash: token.tokenHash,
    tokenPrefix: token.tokenPrefix,
    scopes: scopesForDevice(code.id),
  });

  const response: DeviceTokenResponse = deviceTokenResponseSchema.parse({
    status: 'approved',
    token: token.token,
    tokenPrefix: device.tokenPrefix,
    user: { id: user.id, login: user.login, name: user.name },
  });
  return apiJson(response, 200);
}
