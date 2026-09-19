import { z } from 'zod';

/**
 * Every environment variable the web app reads, parsed with zod. Nothing in this file logs a value:
 * a misconfiguration is reported by variable name only, and none of it is exposed to the client.
 */
const envSchema = z.object({
  ARENA_WEB_URL: z.string().trim().default(''),
  GITHUB_CLIENT_ID: z.string().trim().default(''),
  GITHUB_CLIENT_SECRET: z.string().trim().default(''),
  GITHUB_INSPECT_TOKEN: z.string().trim().default(''),
  ARENA_DEV_LOGIN: z.string().trim().default(''),
  NODE_ENV: z.string().trim().default('development'),
});

export type Env = z.infer<typeof envSchema>;

const urlSchema = z.url();
const FALLBACK_URL = 'http://localhost:3000';

/** Read on every call, so a restart is all that is needed to pick up a change. */
function env(): Env {
  const raw = {
    ARENA_WEB_URL: process.env.ARENA_WEB_URL,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    GITHUB_INSPECT_TOKEN: process.env.GITHUB_INSPECT_TOKEN,
    ARENA_DEV_LOGIN: process.env.ARENA_DEV_LOGIN,
    NODE_ENV: process.env.NODE_ENV,
  };
  const parsed = envSchema.safeParse(raw);
  return parsed.success ? parsed.data : envSchema.parse({});
}

/**
 * Public base URL, without a trailing slash: OAuth callbacks, device-login links and the URLs handed
 * to the CLI. ARENA_SITE_URL (what lib/brand.ts uses for canonical links) is accepted as a fallback,
 * so a deployment that sets only one of the two still produces working links.
 */
export function webUrl(): string {
  const candidates = [
    env().ARENA_WEB_URL,
    process.env.ARENA_SITE_URL ?? '',
    process.env.NEXT_PUBLIC_SITE_URL ?? '',
  ];
  const found = candidates.find((value) => value.length > 0 && urlSchema.safeParse(value).success);
  return (found ?? FALLBACK_URL).replace(/\/+$/, '');
}

export function absoluteUrl(path: string): string {
  return `${webUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** null when the OAuth app is not configured; the sign-in button explains that instead of failing. */
export function githubOAuth(): GithubOAuthConfig | null {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = env();
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) return null;
  return { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET };
}

/** Read-only token for GitHub repository inspection. Server-side only, never sent to a client. */
export function inspectToken(): string | null {
  return env().GITHUB_INSPECT_TOKEN || null;
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}

/** Local sign-in without an OAuth app. Impossible in production, whatever the flag says. */
export function devLoginEnabled(): boolean {
  return env().ARENA_DEV_LOGIN === '1' && !isProduction();
}

/** Which environment variables are missing, by name, for the settings and login pages. */
export function missingEnvNames(): string[] {
  const names: string[] = [];
  if (!githubOAuth()) names.push('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET');
  return names;
}
