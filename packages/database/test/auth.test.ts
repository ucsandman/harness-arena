import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArenaDb } from '../src/client.js';
import {
  approveDeviceCode,
  createDevice,
  createDeviceCode,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  deleteUserSessions,
  denyDeviceCode,
  expireStaleDeviceCodes,
  getDeviceByTokenHash,
  getDeviceCodeByHash,
  getDeviceCodeByUserCode,
  getSessionUser,
  listDevices,
  revokeDevice,
  upsertGithubUser,
} from '../src/queries.js';
import { freshDb } from './helpers.js';

let handle: ArenaDb;

beforeEach(async () => {
  handle = await freshDb();
});

afterEach(async () => {
  await handle.close();
});

const HOUR = 3600_000;

describe('users', () => {
  it('upserts by github id instead of creating duplicates', async () => {
    const first = await upsertGithubUser(handle.db, { githubId: 42, login: 'wes', name: 'Wes' });
    const second = await upsertGithubUser(handle.db, {
      githubId: 42,
      login: 'wes-renamed',
      name: 'Wes S',
      avatarUrl: 'https://example.test/a.png',
    });
    expect(second.id).toBe(first.id);
    expect(second.login).toBe('wes-renamed');
    expect(second.avatarUrl).toBe('https://example.test/a.png');
    expect(second.plan).toBe('free');
    expect(second.email).toBeNull();
  });
});

describe('sessions', () => {
  it('resolves a live session and rejects an expired one', async () => {
    const user = await upsertGithubUser(handle.db, { githubId: 1, login: 'a' });
    const now = new Date();
    await createSession(handle.db, user.id, 'hash-live', new Date(now.getTime() + HOUR), 'vitest');
    await createSession(handle.db, user.id, 'hash-dead', new Date(now.getTime() - HOUR));

    const live = await getSessionUser(handle.db, 'hash-live', now);
    expect(live?.user.id).toBe(user.id);
    expect(live?.session.userAgent).toBe('vitest');
    expect(await getSessionUser(handle.db, 'hash-dead', now)).toBeNull();
    expect(await getSessionUser(handle.db, 'hash-unknown', now)).toBeNull();

    expect(await deleteExpiredSessions(handle.db, now)).toBe(1);
    expect(await deleteSession(handle.db, 'hash-live')).toBe(true);
    expect(await deleteSession(handle.db, 'hash-live')).toBe(false);
  });

  it('deletes every session of a user on logout-everywhere', async () => {
    const user = await upsertGithubUser(handle.db, { githubId: 2, login: 'b' });
    const expiresAt = new Date(Date.now() + HOUR);
    await createSession(handle.db, user.id, 'h1', expiresAt);
    await createSession(handle.db, user.id, 'h2', expiresAt);
    expect(await deleteUserSessions(handle.db, user.id)).toBe(2);
    expect(await getSessionUser(handle.db, 'h1')).toBeNull();
  });
});

describe('device flow', () => {
  it('runs the full lifecycle: code -> approval -> token -> revocation', async () => {
    const user = await upsertGithubUser(handle.db, { githubId: 3, login: 'c' });
    const now = new Date();

    const code = await createDeviceCode(handle.db, {
      deviceCodeHash: 'device-code-hash',
      userCode: 'abcd-1234',
      deviceName: 'wes-desktop',
      expiresAt: new Date(now.getTime() + 600_000),
    });
    expect(code.status).toBe('pending');
    expect(code.userCode).toBe('ABCD-1234');

    expect((await getDeviceCodeByUserCode(handle.db, 'abcd-1234'))?.id).toBe(code.id);
    expect((await getDeviceCodeByHash(handle.db, 'device-code-hash'))?.id).toBe(code.id);
    expect(await getDeviceCodeByUserCode(handle.db, 'ZZZZ-9999')).toBeNull();

    const approved = await approveDeviceCode(handle.db, code.id, user.id, now);
    expect(approved?.status).toBe('approved');
    expect(approved?.userId).toBe(user.id);
    expect(await approveDeviceCode(handle.db, code.id, user.id, now)).toBeNull();

    const device = await createDevice(handle.db, {
      userId: user.id,
      name: code.deviceName,
      tokenHash: 'token-hash',
      tokenPrefix: 'arena_ab',
    });
    expect(device.scopes).toEqual(['battles:write']);
    expect(device.lastUsedAt).toBeNull();

    const authed = await getDeviceByTokenHash(handle.db, 'token-hash');
    expect(authed?.device.id).toBe(device.id);
    expect(authed?.user.id).toBe(user.id);
    expect(authed?.device.lastUsedAt).not.toBeNull();

    expect(await listDevices(handle.db, user.id)).toHaveLength(1);
    expect(await revokeDevice(handle.db, 'usr_someoneelse00', device.id)).toBe(false);
    expect(await revokeDevice(handle.db, user.id, device.id)).toBe(true);
    expect(await getDeviceByTokenHash(handle.db, 'token-hash')).toBeNull();
    expect(await revokeDevice(handle.db, user.id, device.id)).toBe(false);
  });

  it('denies a code and never approves an expired one', async () => {
    const user = await upsertGithubUser(handle.db, { githubId: 4, login: 'd' });
    const now = new Date();
    const denied = await createDeviceCode(handle.db, {
      deviceCodeHash: 'h-denied',
      userCode: 'DENY-0001',
      deviceName: 'laptop',
      expiresAt: new Date(now.getTime() + 600_000),
    });
    expect((await denyDeviceCode(handle.db, denied.id))?.status).toBe('denied');
    expect(await denyDeviceCode(handle.db, denied.id)).toBeNull();

    const stale = await createDeviceCode(handle.db, {
      deviceCodeHash: 'h-stale',
      userCode: 'STAL-0002',
      deviceName: 'laptop',
      expiresAt: new Date(now.getTime() - 1000),
    });
    expect(await approveDeviceCode(handle.db, stale.id, user.id, now)).toBeNull();
    expect(await expireStaleDeviceCodes(handle.db, now)).toBe(1);
    expect((await getDeviceCodeByHash(handle.db, 'h-stale'))?.status).toBe('expired');
    expect(await expireStaleDeviceCodes(handle.db, now)).toBe(0);
  });
});
