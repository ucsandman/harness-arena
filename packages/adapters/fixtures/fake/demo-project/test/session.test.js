import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, isExpired } from '../src/auth/session.js';

const NOW = 1700000000000;

test('a session that expired a minute ago is expired', () => {
  assert.equal(isExpired({ expiresAt: NOW / 1000 - 60 }, NOW), true);
});

test('a fresh session is not expired', () => {
  assert.equal(isExpired(createSession('u1', NOW), NOW), false);
});
