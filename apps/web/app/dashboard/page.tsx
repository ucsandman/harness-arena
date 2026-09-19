import type { Metadata } from 'next';
import Link from 'next/link';
import { listDevices, listHarnesses, listUserBattles } from '@harness-arena/database';
import { BattleList, EmptyBattles } from '@/components/battles/BattleList';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { Stat } from '@/components/ui/Stat';
import { requireUser } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Your battles, harnesses and connected devices.',
  robots: { index: false, follow: false },
};

/** How many battles the list below shows. One row is fetched past it to tell a total from a page. */
const BATTLES_SHOWN = 20;
/** `listHarnesses` pages; an owner with more than this many harnesses sees a floor, not a total. */
const HARNESS_PAGE = 200;

export default async function DashboardPage() {
  const user = await requireUser('/dashboard');
  const dbh = await db();
  const [battlePage, devices, allHarnesses] = await Promise.all([
    listUserBattles(dbh, user.id, BATTLES_SHOWN + 1),
    listDevices(dbh, user.id),
    listHarnesses(dbh, { limit: HARNESS_PAGE, ownerUserId: user.id }),
  ]);
  const battles = battlePage.slice(0, BATTLES_SHOWN);
  // Neither count is a total once its page is full, so the stats read as a floor instead of lying
  const moreBattles = battlePage.length > BATTLES_SHOWN;
  const harnesses = allHarnesses;
  const partialCatalog = allHarnesses.length >= HARNESS_PAGE;
  const activeDevices = devices.filter((device) => device.revokedAt === null);

  return (
    <Container className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Welcome, {user.name ?? user.login}</h1>
          <p className="mt-1 text-[0.9375rem] text-fg-muted">
            Battles run on your machine. This is what you have chosen to upload.
          </p>
        </div>
        <div className="flex gap-2">
          <Button href="/battles/new" size="sm">
            New battle spec
          </Button>
          <Button href="/harnesses/import" size="sm" variant="secondary">
            Import a harness
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Card>
          <CardBody>
            <Stat
              label="Battles uploaded"
              value={moreBattles ? `${BATTLES_SHOWN}+` : battles.length}
              hint={moreBattles ? `newest ${BATTLES_SHOWN} listed below` : undefined}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Harnesses imported"
              value={partialCatalog ? `${harnesses.length}+` : harnesses.length}
              hint={partialCatalog ? `found in your newest ${HARNESS_PAGE} harnesses` : undefined}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Devices connected"
              value={activeDevices.length}
              hint={
                activeDevices.length > 0
                  ? `last used ${relativeTime(activeDevices[0]?.lastUsedAt?.toISOString() ?? null)}`
                  : 'run arena login'
              }
            />
          </CardBody>
        </Card>
      </div>

      <section className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">My battles</h2>
          <Link href="/battles" className="text-2xs text-accent hover:underline">
            All battles
          </Link>
        </div>
        <BattleList
          battles={battles}
          empty={
            <EmptyBattles
              title="Nothing uploaded yet"
              note="Run a battle with an upload level above none, or save a spec here and run it from the CLI."
            />
          }
        />
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>My harnesses</CardTitle>
            <Link href="/harnesses" className="text-2xs text-accent hover:underline">
              Browse all
            </Link>
          </CardHeader>
          <CardBody>
            {harnesses.length === 0 ? (
              <p className="text-[0.8125rem] text-fg-muted">
                None yet.{' '}
                <Link href="/harnesses/import" className="text-accent hover:underline">
                  Import one
                </Link>{' '}
                from a GitHub URL: Arena reads it over the API, never clones it, and never runs it.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {harnesses.map((harness) => (
                  <li key={harness.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/harnesses/${harness.slug}`} className="text-sm hover:text-accent">
                      {harness.name}
                    </Link>
                    <Badge variant="outline">{harness.framework}</Badge>
                    <span className="font-mono text-2xs text-fg-subtle">{harness.slug}</span>
                  </li>
                ))}
              </ul>
            )}
            {partialCatalog ? (
              <p className="mt-2 text-2xs text-fg-subtle">
                Only your newest {HARNESS_PAGE} harnesses are searched, so an older one can be missing from
                this list.
              </p>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick start</CardTitle>
            <Link href="/docs/cli" className="text-2xs text-accent hover:underline">
              CLI guide
            </Link>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <CodeBlock
              terminal
              code={[
                BRAND.cli.install,
                `${BRAND.cli.bin} login`,
                `${BRAND.cli.bin} battle --task "Fix the failing test" --a vanilla --b ./my-harness --upload events`,
              ].join('\n')}
            />
            <p className="text-2xs text-fg-subtle">
              Devices:{' '}
              <Link href="/settings" className="text-accent hover:underline">
                manage or revoke tokens
              </Link>
              .
            </p>
          </CardBody>
        </Card>
      </section>
    </Container>
  );
}
