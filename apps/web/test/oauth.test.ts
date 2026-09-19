import './setup-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as startGithub } from '@/app/api/auth/github/route';
import { GET as githubCallback } from '@/app/api/auth/github/callback/route';
import { POST as devLogin } from '@/app/api/auth/dev/route';
import { OAUTH_STATE_COOKIE, SESSION_COOKIE } from '@/lib/auth';
import { url } from './helpers';

const CLIENT_ID = 'test-client-id';

function setCookies(): Record<string, string> {
  return { cookie: `${OAUTH_STATE_COOKIE}=state-from-this-browser` };
}

describe('GitHub OAuth routes', () => {
  beforeEach(() => {
    process.env.GITHUB_CLIENT_ID = CLIENT_ID;
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
  });

  afterEach(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  it('redirects to GitHub with a state cookie', async () => {
    const response = startGithub(new Request(url('/api/auth/github?next=/dashboard')));
    expect(response.status).toBe(307);

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/github/callback');
    expect(location.searchParams.get('scope')).toBe('read:user user:email');
    const state = location.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[0-9a-f]{32}$/);

    const cookie = response.cookies.get(OAUTH_STATE_COOKIE);
    expect(cookie?.value).toBe(state);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
  });

  it('rejects a callback whose state does not match the cookie', async () => {
    const response = await githubCallback(
      new Request(url('/api/auth/github/callback?code=abc&state=forged-state'), { headers: setCookies() }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?error=invalid_state');
    expect(response.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
  });

  it('rejects a callback with no state cookie at all, and a denied authorization', async () => {
    const noCookie = await githubCallback(new Request(url('/api/auth/github/callback?code=abc&state=x')));
    expect(noCookie.headers.get('location')).toContain('error=invalid_state');

    const denied = await githubCallback(
      new Request(url('/api/auth/github/callback?error=access_denied'), { headers: setCookies() }),
    );
    expect(denied.headers.get('location')).toContain('error=denied');
  });

  it('sends the visitor back to /login when no OAuth app is configured', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    const response = startGithub(new Request(url('/api/auth/github')));
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?error=not_configured');
  });
});

describe('dev login route', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.ARENA_DEV_LOGIN;
  });

  it('answers 404 in production even with ARENA_DEV_LOGIN=1', async () => {
    process.env.ARENA_DEV_LOGIN = '1';
    vi.stubEnv('NODE_ENV', 'production');

    const response = await devLogin(new Request(url('/api/auth/dev'), { method: 'POST' }));
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('answers 404 when the flag is absent outside production', async () => {
    delete process.env.ARENA_DEV_LOGIN;
    const response = await devLogin(new Request(url('/api/auth/dev'), { method: 'POST' }));
    expect(response.status).toBe(404);
  });

  it('creates a session for the local dev user when enabled', async () => {
    process.env.ARENA_DEV_LOGIN = '1';
    const form = new FormData();
    form.set('next', '/dashboard');

    const response = await devLogin(new Request(url('/api/auth/dev'), { method: 'POST', body: form }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/dashboard');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie.toLowerCase()).toContain('httponly');
  });
});
