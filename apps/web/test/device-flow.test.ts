import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DeviceTokenResponse } from '@harness-arena/protocol';
import {
  approveDeviceCode,
  createDeviceCode,
  denyDeviceCode,
  getDeviceCodeByUserCode,
} from '@harness-arena/database';
import { POST as requestCode } from '@/app/api/v1/device/code/route';
import { POST as requestToken } from '@/app/api/v1/device/token/route';
import { GET as me } from '@/app/api/v1/me/route';
import { resetRateLimits } from '@/lib/api';
import { sha256 } from '@/lib/auth';
import { jsonOf, jsonRequest, getRequest, makeUser, testDb } from './helpers';

interface CodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

async function startLogin(deviceName: string): Promise<CodeResponse> {
  const res = await requestCode(jsonRequest('/api/v1/device/code', { deviceName, arenaVersion: '0.1.0' }));
  expect(res.status).toBe(200);
  return jsonOf<CodeResponse>(res);
}

async function poll(deviceCode: string): Promise<DeviceTokenResponse> {
  const res = await requestToken(jsonRequest('/api/v1/device/token', { deviceCode }));
  expect(res.status).toBe(200);
  return jsonOf<DeviceTokenResponse>(res);
}

describe('device login', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('runs code -> pending -> approved -> token, and never issues the token twice', async () => {
    const started = await startLogin('laptop');
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.verificationUri).toBe('http://localhost:3000/device');
    expect(started.verificationUriComplete).toBe(
      `http://localhost:3000/device?code=${encodeURIComponent(started.userCode)}`,
    );
    expect(started.expiresIn).toBe(900);
    expect(started.interval).toBe(5);

    const pending = await poll(started.deviceCode);
    expect(pending.status).toBe('pending');

    // the browser half: exactly the queries the /device server action runs
    const dbh = await testDb();
    const user = await makeUser('device-approver', 9001);
    const row = await getDeviceCodeByUserCode(dbh, started.userCode);
    expect(row?.deviceName).toBe('laptop');
    const approved = await approveDeviceCode(dbh, row?.id ?? '', user.id);
    expect(approved?.status).toBe('approved');

    const issued = await poll(started.deviceCode);
    expect(issued.status).toBe('approved');
    if (issued.status !== 'approved') throw new Error('unreachable');
    expect(issued.token.startsWith('arena_dev_')).toBe(true);
    expect(issued.tokenPrefix).toHaveLength(8);
    expect(issued.user.login).toBe('device-approver');

    // the token works
    const whoami = await me(getRequest('/api/v1/me', { token: issued.token }));
    expect(whoami.status).toBe(200);
    const body = await jsonOf<{ user: { login: string }; device: { name: string } }>(whoami);
    expect(body.user.login).toBe('device-approver');
    expect(body.device.name).toBe('laptop');

    // a second poll must not mint a second token for the same code
    const again = await poll(started.deviceCode);
    expect(again.status).toBe('expired');
  });

  it('reports a denied code', async () => {
    const started = await startLogin('denied machine');
    const dbh = await testDb();
    const row = await getDeviceCodeByUserCode(dbh, started.userCode);
    await denyDeviceCode(dbh, row?.id ?? '');

    const result = await poll(started.deviceCode);
    expect(result.status).toBe('denied');
  });

  it('refuses an approved code once it has expired', async () => {
    const dbh = await testDb();
    const user = await makeUser('device-abandoned', 9003);
    const deviceCode = 'a'.repeat(64);
    // the state an abandoned login leaves behind: approved in the browser, never polled again
    const created = await createDeviceCode(dbh, {
      deviceCodeHash: sha256(deviceCode),
      userCode: 'ZZZZ-0001',
      deviceName: 'abandoned laptop',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const approved = await approveDeviceCode(dbh, created.id, user.id, new Date(Date.now() - 120_000));
    expect(approved?.status).toBe('approved');

    const result = await poll(deviceCode);
    expect(result.status).toBe('expired');
  });

  it('rejects an unknown device code and an invalid body', async () => {
    const unknown = await requestToken(jsonRequest('/api/v1/device/token', { deviceCode: 'f'.repeat(64) }));
    expect(unknown.status).toBe(404);
    const unknownBody = await jsonOf<{ error: { code: string; message: string } }>(unknown);
    expect(unknownBody.error.code).toBe('not_found');
    expect(typeof unknownBody.error.message).toBe('string');

    const invalid = await requestCode(jsonRequest('/api/v1/device/code', { deviceName: '' }));
    expect(invalid.status).toBe(400);
    const body = await jsonOf<{ error: { code: string } }>(invalid);
    expect(body.error.code).toBe('invalid_request');
  });
});
