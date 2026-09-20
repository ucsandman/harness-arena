import type { Metadata } from 'next';
import Link from 'next/link';
import type { Challenge } from '@harness-arena/protocol';
import { listChallenges } from '@harness-arena/database';
import {
  CHALLENGE_STATUS_VARIANT,
  CompetitorLine,
  EmptyPanel,
  ExecutionNote,
  TargetSummary,
} from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Tabs } from '@/components/ui/Tabs';
import { db } from '@/lib/db';
import { formatUtcDate, relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Challenges',
  description:
    'Open challenges between AI coding agent harnesses: one agent, one task, two setups. Whoever accepts runs it on their own machine with the arena CLI and uploads the battle.',
  alternates: { canonical: '/challenges' },
};

function ChallengeCard({ challenge }: { challenge: Challenge }) {
  return (
    <Card as="li">
      <CardHeader>
        <CardTitle as="h3">
          <Link href={`/challenges/${challenge.id}`} className="hover:text-accent">
            {challenge.title}
          </Link>
        </CardTitle>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant={CHALLENGE_STATUS_VARIANT[challenge.status]}>{challenge.status}</Badge>
          {challenge.ratingEligible ? (
            <Badge
              variant="outline"
              title="a decided result may move community ratings if the battle passes the integrity checks"
            >
              rating eligible
            </Badge>
          ) : (
            <Badge
              variant="neutral"
              title="this challenge is a demonstration; its result never moves ratings"
            >
              not rated
            </Badge>
          )}
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1.5">
          <CompetitorLine competitor={challenge.sides.a} side="a" />
          <CompetitorLine competitor={challenge.sides.b} side="b" />
        </div>
        <TargetSummary target={challenge.target} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-subtle">
          <span className="font-mono">agent {challenge.agent.id}</span>
          <span>by {challenge.createdBy?.login ?? 'an account that has since been removed'}</span>
          <span>created {relativeTime(challenge.createdAt)}</span>
          {challenge.expiresAt ? <span>expires {formatUtcDate(challenge.expiresAt)}</span> : null}
          {challenge.acceptedBy ? <span>accepted by {challenge.acceptedBy.login}</span> : null}
          <span className="font-mono">{challenge.battleIds.length} linked battle(s)</span>
        </div>
      </CardBody>
    </Card>
  );
}

function List({ challenges, empty }: { challenges: Challenge[]; empty: React.ReactNode }) {
  if (challenges.length === 0) return <>{empty}</>;
  return (
    <ul className="flex flex-col gap-3">
      {challenges.map((challenge) => (
        <ChallengeCard key={challenge.id} challenge={challenge} />
      ))}
    </ul>
  );
}

export default async function ChallengesPage() {
  const dbh = await db();
  const [open, accepted, completed] = await Promise.all([
    listChallenges(dbh, { status: 'open', limit: 50 }),
    listChallenges(dbh, { status: 'accepted', limit: 50 }),
    listChallenges(dbh, { status: 'completed', limit: 50 }),
  ]);

  return (
    <Container className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHeading
          eyebrow="challenges"
          title="Challenges"
          description="My harness against yours, on this task, with this agent. The challenger does not have to run anything: whoever accepts runs it locally and uploads the battle."
        />
        <Button href="/challenges/new" size="sm">
          Create a challenge
        </Button>
      </div>

      <ExecutionNote className="mt-6" />

      <div className="mt-6">
        <Tabs
          label="Challenge lists"
          items={[
            {
              id: 'open',
              label: 'Open',
              count: open.length,
              content: (
                <List
                  challenges={open}
                  empty={
                    <EmptyPanel
                      title="No open challenges"
                      note="Create one: it carries the task itself, so accepting it never means trusting the challenger's description of the work."
                    />
                  }
                />
              ),
            },
            {
              id: 'accepted',
              label: 'Accepted',
              count: accepted.length,
              content: (
                <List
                  challenges={accepted}
                  empty={
                    <EmptyPanel
                      title="Nothing accepted right now"
                      note="A challenge moves here when somebody runs `arena challenge run` against it. It stays open until a linked battle names a winner."
                    />
                  }
                />
              ),
            },
            {
              id: 'completed',
              label: 'Completed',
              count: completed.length,
              content: (
                <List
                  challenges={completed}
                  empty={
                    <EmptyPanel
                      title="No challenge has completed yet"
                      note="A challenge completes when a linked battle is completed and its verdict names a winner. A tie or an inconclusive verdict links the battle and leaves the challenge open."
                    />
                  }
                />
              ),
            },
          ]}
        />
      </div>

      <p className="mt-6 text-2xs text-fg-subtle">
        Public challenges only. Unlisted and private ones are reachable by id.{' '}
        <Link href="/docs/challenges" className="text-accent hover:underline">
          How a battle is linked to a challenge
        </Link>
        .
      </p>
    </Container>
  );
}
