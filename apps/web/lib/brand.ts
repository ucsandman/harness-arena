/**
 * Single source of truth for every user-visible product name and URL.
 * Renaming the product means editing this file (see docs/ARCHITECTURE.md, "Renaming").
 */
export const BRAND = {
  name: 'Harness Arena',
  shortName: 'Arena',
  tagline: 'Your AI harness feels better. Prove it.',
  description:
    'Battle two AI coding agent setups on the same task through the CLIs you already pay for, capture ' +
    'telemetry, and get a deterministic battle report.',
  cli: {
    bin: 'arena',
    install: 'npm install -g harness-arena',
    npx: 'npx harness-arena',
  },
  github: 'https://github.com/ucsandman/harness-arena',
  twitter: null,
} as const;

export type Brand = typeof BRAND;

/** Absolute base URL for canonical links and OG images. Set ARENA_SITE_URL in production. */
export function siteUrl(): string {
  const raw = process.env.ARENA_SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}
