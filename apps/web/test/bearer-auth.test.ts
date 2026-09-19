import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import { revokeDevice } from '@harness-arena/database';
import { GET as me } from '@/app/api/v1/me/route';
import { DELETE as revokeCurrent } from '@/app/api/v1/devices/current/route';
import { DEVICE_TOKEN_PREFIX } from '@/lib/auth';
import { RATE_LIMIT, clientIp, enforceRateLimit, readJsonBody, resetRateLimits } from '@/lib/api';
import { getRequest, jsonOf, makeDevice, testDb, url } from './helpers';

describe('bearer authentication', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('answers 401 JSON without a token', async () => {
    const res = await me(getRequest('/api/v1/me'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const body = await jsonOf<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('unauthorized');
    // never a stack trace
    expect(body.error.message).not.toContain('    at ');
  });

  it('answers 401 for a well-formed but unknown token and for a malformed header', async () => {
    const unknown = await me(getRequest('/api/v1/me', { token: `${DEVICE_TOKEN_PREFIX}nope` }));
    expect(unknown.status).toBe(401);

    const malformed = await me(new Request(url('/api/v1/me'), { headers: { authorization: 'Token abc' } }));
    expect(malformed.status).toBe(401);
    const body = await jsonOf<{ error: { code: string } }>(malformed);
    expect(body.error.code).toBe('unauthorized');
  });

  it('accepts a live token and refuses a revoked one', async () => {
    const { token, device, user } = await makeDevice('bearer-user', 9101);
    const ok = await me(getRequest('/api/v1/me', { token }));
    expect(ok.status).toBe(200);

    const dbh = await testDb();
    expect(await revokeDevice(dbh, user.id, device.id)).toBe(true);

    const after = await me(getRequest('/api/v1/me', { token }));
    expect(after.status).toBe(401);
  });

  it('lets a device revoke itself, once', async () => {
    const { token } = await makeDevice('self-revoker', 9102);
    const first = await revokeCurrent(
      new Request(url('/api/v1/devices/current'), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(first.status).toBe(200);

    const second = await me(getRequest('/api/v1/me', { token }));
    expect(second.status).toBe(401);
  });

  it('stops reading a chunked body once it passes the size cap', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20); // 1 MB of spaces
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 8) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    // no content-length: a chunked upload declares no size, so only the reader can bound it
    const request = new Request(url('/api/v1/battles'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const result = await readJsonBody(request);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the body to be refused');
    expect(result.response.status).toBe(413);
    // the 4 MB cap is crossed by the fifth chunk; the remaining 3 MB is never buffered
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it('never turns a client-supplied x-forwarded-for into a rate-limit identity', () => {
    const anonymous = (): Request => new Request(url('/api/v1/device/token'), { method: 'POST' });
    const forged = (n: number): Request =>
      new Request(url('/api/v1/device/token'), {
        method: 'POST',
        headers: { 'x-forwarded-for': `1.2.3.${n}` },
      });

    // no proxy configured: the header is the caller's own claim, so it is not an identity
    expect(clientIp(anonymous())).toBeNull();
    expect(clientIp(forged(9))).toBeNull();
    // with one proxy in front, only the hop that proxy appended counts; the forged prefix is ignored
    expect(clientIp(forged(9), 1)).toBe('1.2.3.9');
    expect(
      clientIp(new Request(url('/api/v1/me'), { headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' } }), 1),
    ).toBe('203.0.113.7');

    // and a proxy-less deployment does not put every anonymous caller in one 120-request window
    resetRateLimits();
    let refused = 0;
    for (let i = 0; i <= RATE_LIMIT.max; i++) {
      if (enforceRateLimit('device-token', clientIp(forged(i)))) refused += 1;
    }
    expect(refused).toBe(0);
    resetRateLimits();
  });
});
