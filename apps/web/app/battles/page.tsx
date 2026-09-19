import type { Metadata } from 'next';
import { listBattles, listUserBattles } from '@harness-arena/database';
import { BattleList, EmptyBattles } from '@/components/battles/BattleList';
import { Button } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Tabs } from '@/components/ui/Tabs';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Battles',
  description:
    'Public battles between AI coding agent harnesses: the same task, the same commit, two setups, and a deterministic report for each one.',
  alternates: { canonical: '/battles' },
};

const PUBLIC_EMPTY = (
  <EmptyBattles
    title="No public battles yet"
    note="Battles run on your own machine through the CLIs you already authenticate. Run one, then set its visibility to public to see it here."
  />
);

export default async function BattlesPage() {
  const dbh = await db();
  const user = await getCurrentUser();
  const [feed, mine] = await Promise.all([
    listBattles(dbh, { limit: 30, viewerUserId: null }),
    user ? listUserBattles(dbh, user.id, 30) : Promise.resolve([]),
  ]);

  const publicList = <BattleList battles={feed.items} empty={PUBLIC_EMPTY} />;

  return (
    <Container className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHeading
          eyebrow="battles"
          title="Battles"
          description="Every battle is two harnesses on one task at one commit, measured with the telemetry the agent CLIs actually report."
        />
        <Button href="/battles/new" size="sm">
          New battle spec
        </Button>
      </div>

      <div className="mt-6">
        {user ? (
          <Tabs
            label="Battle lists"
            items={[
              { id: 'public', label: 'Public', count: feed.items.length, content: publicList },
              {
                id: 'mine',
                label: 'Mine',
                count: mine.length,
                content: (
                  <BattleList
                    battles={mine}
                    empty={
                      <EmptyBattles
                        title="You have not uploaded a battle yet"
                        note="Battles stay on your machine until you choose to upload them. Sign the CLI in with arena login, then run a battle with an upload level."
                      />
                    }
                  />
                ),
              },
            ]}
          />
        ) : (
          publicList
        )}
      </div>

      {feed.nextCursor ? (
        <p className="mt-4 text-2xs text-fg-subtle">
          Showing the {feed.items.length} most recent public battles.
        </p>
      ) : null}
    </Container>
  );
}
