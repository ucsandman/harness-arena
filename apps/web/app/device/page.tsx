import type { Metadata } from 'next';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { getDeviceCodeByUserCode } from '@harness-arena/database';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { normalizeUserCode, requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { formatUtcTime } from '@/lib/format';
import { approveDeviceAction, denyDeviceAction } from './actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect a device',
  description: 'Approve the code shown by the arena CLI to connect it to your account.',
  robots: { index: false, follow: false },
};

const ERRORS: Record<string, string> = {
  missing: 'Enter the code the CLI printed.',
  unknown: 'No login is waiting for that code. Check the CLI output, or run "arena login" again.',
  stale: 'That code was already used, denied, or has expired. Run "arena login" again.',
};

interface PageProps {
  searchParams: Promise<{ code?: string; error?: string; done?: string }>;
}

const INPUT =
  'h-10 w-48 rounded-md border border-border-strong bg-surface px-3 font-mono text-sm uppercase tracking-widest text-fg';

export default async function DevicePage({ searchParams }: PageProps) {
  const { code: rawCode, error, done } = await searchParams;
  const code = normalizeUserCode(rawCode ?? '');
  await requireUser(code.length > 0 ? `/device?code=${code}` : '/device');

  if (done === 'approved' || done === 'denied') {
    return (
      <Container className="py-14" size="prose">
        <Card>
          <CardBody className="flex flex-col items-start gap-2">
            {done === 'approved' ? (
              <CheckCircle2 size={22} className="text-success" aria-hidden="true" />
            ) : (
              <ShieldAlert size={22} className="text-warn" aria-hidden="true" />
            )}
            <h1 className="text-xl font-semibold">
              {done === 'approved' ? 'Device connected' : 'Request denied'}
            </h1>
            <p className="text-[0.9375rem] text-fg-muted">
              {done === 'approved'
                ? 'The CLI has received its token. You can close this window.'
                : 'Nothing was connected. You can close this window.'}
            </p>
            <p className="text-2xs text-fg-subtle">
              Tokens are revocable at any time from{' '}
              <a href="/settings" className="text-accent hover:underline">
                Settings
              </a>
              .
            </p>
          </CardBody>
        </Card>
      </Container>
    );
  }

  const dbh = await db();
  const pending = code.length > 0 ? await getDeviceCodeByUserCode(dbh, code) : null;
  const usable = pending !== null && pending.status === 'pending' && pending.expiresAt.getTime() > Date.now();
  const message = error ? (ERRORS[error] ?? 'Something went wrong. Run "arena login" again.') : null;

  return (
    <Container className="py-12" size="prose">
      <h1 className="text-2xl font-semibold">Connect the arena CLI</h1>
      <p className="mt-2 text-[0.9375rem] text-fg-muted">
        <span className="font-mono">arena login</span> prints an eight-character code. Type it here to give
        that machine a revocable token for your account.
      </p>

      {message ? (
        <p className="mt-4 rounded-card border border-danger-border bg-danger-subtle px-4 py-2.5 text-[0.8125rem] text-danger">
          {message}
        </p>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Device code</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <form method="get" action="/device" className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="code" className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
                Code
              </label>
              <input
                id="code"
                name="code"
                defaultValue={code}
                placeholder="ABCD-1234"
                autoComplete="off"
                className={INPUT}
              />
            </div>
            <button
              type="submit"
              className="h-10 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-bg-subtle"
            >
              Look up
            </button>
          </form>

          {code.length > 0 && !usable ? (
            <p className="text-[0.8125rem] text-fg-muted">
              No pending login for <span className="font-mono">{code}</span>. Run{' '}
              <span className="font-mono">arena login</span> again to get a fresh code.
            </p>
          ) : null}

          {usable && pending ? (
            <div className="flex flex-col gap-3 rounded-card border border-border bg-bg-subtle px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="accent" mono>
                  {pending.userCode}
                </Badge>
                <span className="text-sm font-medium">{pending.deviceName}</span>
                <span className="ml-auto text-2xs text-fg-subtle">
                  expires {formatUtcTime(pending.expiresAt.toISOString())}
                </span>
              </div>
              <p className="text-2xs text-fg-subtle">
                Approving lets this machine upload battles you choose to upload, and nothing else. It never
                grants access to your GitHub account or to any provider credential.
              </p>
              <div className="flex flex-wrap gap-2">
                <form action={approveDeviceAction}>
                  <input type="hidden" name="userCode" value={pending.userCode} />
                  <button
                    type="submit"
                    className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
                  >
                    Approve
                  </button>
                </form>
                <form action={denyDeviceAction}>
                  <input type="hidden" name="userCode" value={pending.userCode} />
                  <button
                    type="submit"
                    className="h-9 rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-fg hover:bg-bg-subtle"
                  >
                    Deny
                  </button>
                </form>
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </Container>
  );
}
