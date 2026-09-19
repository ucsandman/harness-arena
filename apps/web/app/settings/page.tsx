import type { Metadata } from 'next';
import Link from 'next/link';
import { listDevices } from '@harness-arena/database';
import { DeviceTable } from '@/components/account/DeviceTable';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { formatUtcDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Settings',
  description: 'Your account, connected devices and sign-out.',
  robots: { index: false, follow: false },
};

export default async function SettingsPage() {
  const user = await requireUser('/settings');
  const dbh = await db();
  const devices = await listDevices(dbh, user.id);

  return (
    <Container className="py-10">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-wrap items-center gap-4">
          {/* a remote avatar, served straight from GitHub (allowed by the CSP img-src) */}
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              width={48}
              height={48}
              className="h-12 w-12 rounded-full border border-border"
            />
          ) : (
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-bg-subtle font-mono text-sm">
              {user.login.slice(0, 2).toUpperCase()}
            </span>
          )}
          <div className="flex flex-col">
            <span className="text-sm font-medium">{user.name ?? user.login}</span>
            <span className="font-mono text-2xs text-fg-muted">{user.login}</span>
            <span className="text-2xs text-fg-subtle">
              joined {formatUtcDate(user.createdAt.toISOString())}
            </span>
          </div>
          <form action="/api/auth/logout" method="post" className="ml-auto">
            <button
              type="submit"
              className="h-9 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-bg-subtle"
            >
              Sign out
            </button>
          </form>
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <Link href="/device" className="text-2xs text-accent hover:underline">
            Connect a device
          </Link>
        </CardHeader>
        <div className="border-t border-border">
          <DeviceTable devices={devices} />
        </div>
      </Card>

      <p className="mt-4 text-2xs text-fg-subtle">
        Device tokens are stored as sha256 hashes and shown to the CLI exactly once. Revoking one takes effect
        on its next request. Arena never stores a provider credential;{' '}
        <Link href="/privacy" className="text-accent hover:underline">
          see the privacy page
        </Link>
        .
      </p>
    </Container>
  );
}
