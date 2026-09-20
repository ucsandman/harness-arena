import type { Metadata } from 'next';
import Link from 'next/link';
import type { Bounty } from '@harness-arena/protocol';
import { listBounties } from '@harness-arena/database';
import {
  BOUNTY_STATUS_VARIANT,
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
  title: 'Bounties',
  description:
    'Beat this baseline on this task and the poster says so publicly. Arena moves no money: a reward is reputation or something the poster settles elsewhere.',
  alternates: { canonical: '/bounties' },
};

function conditionLine(bounty: Bounty): string {
  const parts = [`must win ${bounty.condition.mustWin}`, `at least ${bounty.condition.minBattles} battle(s)`];
  if (bounty.condition.maxTokensRatio !== undefined) {
    parts.push(`tokens <= ${bounty.condition.maxTokensRatio} x baseline`);
  }
  if (bounty.condition.maxCostRatio !== undefined) {
    parts.push(`cost <= ${bounty.condition.maxCostRatio} x baseline`);
  }
  if (bounty.condition.maxDurationRatio !== undefined) {
    parts.push(`duration <= ${bounty.condition.maxDurationRatio} x baseline`);
  }
  return parts.join(' · ');
}

function BountyCard({ bounty }: { bounty: Bounty }) {
  return (
    <Card as="li">
      <CardHeader>
        <CardTitle as="h3">
          <Link href={`/bounties/${bounty.id}`} className="hover:text-accent">
            {bounty.title}
          </Link>
        </CardTitle>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant={BOUNTY_STATUS_VARIANT[bounty.status]}>{bounty.status}</Badge>
          <Badge variant="outline">reward: {bounty.reward.kind}</Badge>
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-fg-muted">Baseline to beat</span>
          <CompetitorLine competitor={bounty.baseline} />
        </div>
        <TargetSummary target={bounty.target} />
        <span className="font-mono text-2xs text-fg-subtle">{conditionLine(bounty)}</span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-subtle">
          <span className="font-mono">agent {bounty.agent.id}</span>
          <span className="font-mono">{bounty.submissionCount} submission(s)</span>
          <span>by {bounty.createdBy?.login ?? 'an account that has since been removed'}</span>
          <span>posted {relativeTime(bounty.createdAt)}</span>
          {bounty.deadline ? <span>deadline {formatUtcDate(bounty.deadline)}</span> : null}
        </div>
      </CardBody>
    </Card>
  );
}

function List({ bounties, empty }: { bounties: Bounty[]; empty: React.ReactNode }) {
  if (bounties.length === 0) return <>{empty}</>;
  return (
    <ul className="flex flex-col gap-3">
      {bounties.map((bounty) => (
        <BountyCard key={bounty.id} bounty={bounty} />
      ))}
    </ul>
  );
}

export default async function BountiesPage() {
  const dbh = await db();
  const [open, closed, awarded] = await Promise.all([
    listBounties(dbh, { status: 'open', limit: 50 }),
    listBounties(dbh, { status: 'closed', limit: 50 }),
    listBounties(dbh, { status: 'awarded', limit: 50 }),
  ]);

  return (
    <Container className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHeading
          eyebrow="bounties"
          title="Bounties"
          description="Beat this baseline on this task and the poster says so publicly. The condition is arithmetic, not judgement: every ratio compares the submission's side to the baseline's side of the same battle."
        />
        <Button href="/bounties/new" size="sm">
          Post a bounty
        </Button>
      </div>

      <ExecutionNote className="mt-6" />
      <p className="mt-3 rounded-card border border-border bg-surface px-4 py-3 text-[0.8125rem] text-fg-muted">
        Arena moves no money. A reward is either reputation or something the poster settles somewhere else, on
        their own terms, and Arena is not a party to it.
      </p>

      <div className="mt-6">
        <Tabs
          label="Bounty lists"
          items={[
            {
              id: 'open',
              label: 'Open',
              count: open.length,
              content: (
                <List
                  bounties={open}
                  empty={
                    <EmptyPanel
                      title="No open bounties"
                      note="Post one: name a baseline, a target and a condition made of numbers. Missing evidence is never a pass, so state only what a battle can actually report."
                    />
                  }
                />
              ),
            },
            {
              id: 'closed',
              label: 'Closed',
              count: closed.length,
              content: (
                <List
                  bounties={closed}
                  empty={
                    <EmptyPanel
                      title="Nothing closed"
                      note="Only the poster can close a bounty. Closing it stops new submissions; the battles already uploaded stay where they are."
                    />
                  }
                />
              ),
            },
            {
              id: 'awarded',
              label: 'Awarded',
              count: awarded.length,
              content: (
                <List
                  bounties={awarded}
                  empty={
                    <EmptyPanel
                      title="Nothing awarded yet"
                      note="A bounty can only be awarded to a submission whose linked battles actually meet the condition: the server re-evaluates first and refuses otherwise."
                    />
                  }
                />
              ),
            },
          ]}
        />
      </div>

      <p className="mt-6 text-2xs text-fg-subtle">
        <Link href="/docs/challenges" className="text-accent hover:underline">
          How a condition is evaluated
        </Link>
        .
      </p>
    </Container>
  );
}
