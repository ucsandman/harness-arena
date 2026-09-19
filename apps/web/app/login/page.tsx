import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { GitHubIcon } from '@/components/ui/GitHubIcon';
import { getCurrentUser } from '@/lib/auth';
import { devLoginEnabled, githubOAuth } from '@/lib/env';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in with GitHub to publish battles, import harnesses and connect the arena CLI.',
  robots: { index: false, follow: false },
};

const ERRORS: Record<string, string> = {
  not_configured:
    'This deployment has no GitHub OAuth app configured (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET).',
  denied: 'GitHub sign-in was cancelled.',
  invalid_state: 'That sign-in link expired or did not match this browser. Please start again.',
  exchange_failed: 'GitHub would not exchange the sign-in code. Please try again.',
  profile_failed: 'GitHub accepted the sign-in but would not return the account profile.',
};

interface PageProps {
  searchParams: Promise<{ error?: string; next?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const { error, next } = await searchParams;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  const user = await getCurrentUser();
  if (user) redirect(safeNext);

  const oauth = githubOAuth();
  const devLogin = devLoginEnabled();
  const message = error ? (ERRORS[error] ?? 'Sign-in failed. Please try again.') : null;

  return (
    <Container className="py-12" size="prose">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-2 text-[0.9375rem] text-fg-muted">
        An account is only needed to publish a battle, import a harness, or connect the CLI. Battles run on
        your machine either way.
      </p>

      {message ? (
        <p className="mt-4 rounded-card border border-danger-border bg-danger-subtle px-4 py-2.5 text-[0.8125rem] text-danger">
          {message}
        </p>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {oauth ? (
            <a
              href={`/api/auth/github?next=${encodeURIComponent(safeNext)}`}
              className="inline-flex h-10 w-fit items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              <GitHubIcon size={15} />
              Continue with GitHub
            </a>
          ) : (
            <>
              <button
                type="button"
                disabled
                className="inline-flex h-10 w-fit cursor-not-allowed items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg opacity-50"
              >
                <GitHubIcon size={15} />
                Continue with GitHub
              </button>
              <p className="text-2xs text-fg-subtle">
                Disabled: this deployment has no <span className="font-mono">GITHUB_CLIENT_ID</span>. Set it
                and <span className="font-mono">GITHUB_CLIENT_SECRET</span> with the callback URL{' '}
                <span className="font-mono">/api/auth/github/callback</span>.
              </p>
            </>
          )}
          <p className="text-2xs text-fg-subtle">
            Signing in stores your GitHub id, login, name and avatar URL. Nothing else, and never a provider
            credential.{' '}
            <Link href="/privacy" className="text-accent hover:underline">
              Read the privacy page
            </Link>
            .
          </p>
        </CardBody>
      </Card>

      {devLogin ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Local development</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <p className="text-[0.8125rem] text-fg-muted">
              <span className="font-mono">ARENA_DEV_LOGIN=1</span> is set, so you can sign in as a local user
              without an OAuth app. This form does not exist in production.
            </p>
            <form action="/api/auth/dev" method="post" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="next" value={safeNext} />
              <button
                type="submit"
                className="inline-flex h-9 items-center rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-bg-subtle"
              >
                Sign in as a local dev user
              </button>
            </form>
          </CardBody>
        </Card>
      ) : null}
    </Container>
  );
}
