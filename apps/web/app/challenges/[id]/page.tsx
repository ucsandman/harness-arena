import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Challenge } from '@harness-arena/protocol';
import { getBattleForViewer, getChallenge } from '@harness-arena/database';
import {
  CHALLENGE_STATUS_VARIANT,
  CompetitorLine,
  EmptyPanel,
  ExecutionNote,
  TargetSummary,
} from '@/components/arena/shared';
import { cancelChallengeAction } from '@/app/challenges/actions';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { getCurrentUser } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { formatUtcDate, relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const dbh = await db();
  const challenge = await getChallenge(dbh, id);
  if (!challenge) return { title: 'Challenge', robots: { index: false, follow: false } };
  return {
    title: challenge.title,
    description:
      challenge.description ??
      `A challenge between two harnesses on ${challenge.agent.id}. Executed locally by whoever accepts it; every result is community-reported.`,
    alternates: { canonical: `/challenges/${challenge.id}` },
    ...(challenge.visibility === 'public' ? {} : { robots: { index: false, follow: false } }),
  };
}

/**
 * Timeline entries in the order they can happen. Only two timestamps are stored (created, completed),
 * so the acceptance step reports who, not when, instead of borrowing another step's date.
 */
function timeline(challenge: Challenge): Array<{ label: string; value: string; note: string }> {
  return [
    {
      label: 'created',
      value: formatUtcDate(challenge.createdAt),
      note: `by ${challenge.createdBy?.login ?? 'an account that has since been removed'}`,
    },
    {
      label: 'accepted',
      value: challenge.acceptedBy ? challenge.acceptedBy.login : 'not yet',
      note: challenge.acceptedBy
        ? 'runs it on their own machine; the acceptance time is not recorded'
        : 'nobody has taken it on yet',
    },
    {
      label: challenge.status === 'cancelled' ? 'cancelled' : 'completed',
      value: challenge.completedAt ? formatUtcDate(challenge.completedAt) : 'not yet',
      note:
        challenge.status === 'completed'
          ? 'a linked battle completed with a decided winner'
          : challenge.status === 'cancelled'
            ? 'the creator withdrew it'
            : challenge.status === 'expired'
              ? 'the deadline passed'
              : 'waiting for a linked battle with a decided winner',
    },
  ];
}

export default async function ChallengeDetailPage({ params }: PageProps) {
  const { id } = await params;
  const dbh = await db();
  const user = await getCurrentUser();
  const challenge = await getChallenge(dbh, id, user?.id ?? null);
  if (!challenge) notFound();

  const linked = await Promise.all(
    challenge.battleIds.slice(0, 20).map(async (battleId) => ({
      id: battleId,
      found: await getBattleForViewer(dbh, battleId, user?.id ?? null),
    })),
  );

  const isCreator = user !== null && challenge.createdBy?.id === user.id;
  const cancellable = isCreator && challenge.status !== 'completed' && challenge.status !== 'cancelled';

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="challenge"
        title={challenge.title}
        description={challenge.description ?? undefined}
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge variant={CHALLENGE_STATUS_VARIANT[challenge.status]}>{challenge.status}</Badge>
        <Badge variant="outline" mono>
          {challenge.id}
        </Badge>
        <Badge variant="neutral" mono>
          agent {challenge.agent.id}
        </Badge>
        {challenge.ratingEligible ? (
          <Badge variant="outline">rating eligible</Badge>
        ) : (
          <Badge variant="neutral">not rated</Badge>
        )}
        {challenge.visibility !== 'public' ? <Badge variant="outline">{challenge.visibility}</Badge> : null}
      </div>

      <ExecutionNote className="mt-6" />

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>The matchup</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <CompetitorLine competitor={challenge.sides.a} side="a" />
            <CompetitorLine competitor={challenge.sides.b} side="b" />
            <p className="text-2xs text-fg-subtle">
              Slot order does not matter: a battle that ran side B first still counts, as long as it ran these
              two harnesses on agent {challenge.agent.id}.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>The work</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <TargetSummary target={challenge.target} />
            <p className="text-2xs text-fg-subtle">
              Uploads happen at the challenge&apos;s own privacy level:{' '}
              <span className="font-mono">{challenge.privacy.upload}</span>. Visibility of the challenge is{' '}
              <span className="font-mono">{challenge.visibility}</span>.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Take it on</CardTitle>
          <span className="text-2xs text-fg-subtle">runs on your machine, with your own CLIs</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          <CodeBlock
            terminal
            code={`${BRAND.cli.bin} login\n${BRAND.cli.bin} challenge run ${challenge.id}`}
          />
          <p className="text-2xs text-fg-subtle">
            That fetches the definition, accepts the challenge on your account, builds the battle spec from
            the challenge&apos;s own target, runs it, and uploads it at the privacy level above.
          </p>
        </CardBody>
      </Card>

      <h2 className="mt-8 text-sm font-semibold">Status</h2>
      <ol className="mt-3 flex flex-col gap-2">
        {timeline(challenge).map((step) => (
          <li
            key={step.label}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-card border border-border bg-surface px-4 py-2.5"
          >
            <span className="font-mono text-2xs uppercase tracking-wide text-fg-muted">{step.label}</span>
            <span className="font-mono text-2xs tabular-nums">{step.value}</span>
            <span className="text-2xs text-fg-subtle">{step.note}</span>
          </li>
        ))}
        {challenge.expiresAt ? (
          <li className="flex flex-wrap items-baseline gap-x-3 rounded-card border border-border bg-surface px-4 py-2.5">
            <span className="font-mono text-2xs uppercase tracking-wide text-fg-muted">deadline</span>
            <span className="font-mono text-2xs tabular-nums">{formatUtcDate(challenge.expiresAt)}</span>
            <span className="text-2xs text-fg-subtle">{relativeTime(challenge.expiresAt)}</span>
          </li>
        ) : null}
      </ol>

      <h2 className="mt-8 text-sm font-semibold">Linked battles</h2>
      <div className="mt-3">
        {linked.length === 0 ? (
          <EmptyPanel
            title="No battle has been linked yet"
            note="A battle is linked only after the server checks it really ran the two harnesses this challenge names, on this agent. A battle that fails that check is still stored; it just does not count here."
          />
        ) : (
          <TableWrap>
            <Table caption="Battles linked to this challenge">
              <THead>
                <TR>
                  <TH>Battle</TH>
                  <TH>Status</TH>
                  <TH>Winner</TH>
                  <TH>Uploaded</TH>
                </TR>
              </THead>
              <TBody>
                {linked.map((entry) => (
                  <TR key={entry.id}>
                    <TD>
                      {entry.found ? (
                        <Link href={`/battles/${entry.id}`} className="font-medium hover:text-accent">
                          {entry.found.battle.title}
                        </Link>
                      ) : (
                        <span className="text-fg-subtle">linked, not visible to you</span>
                      )}
                      <span className="mt-0.5 block font-mono text-2xs text-fg-subtle">{entry.id}</span>
                    </TD>
                    <TD mono className="text-2xs">
                      {entry.found?.battle.status ?? '—'}
                    </TD>
                    <TD>
                      {entry.found?.battle.winner ? (
                        <Badge
                          variant={
                            entry.found.battle.winner === 'a'
                              ? 'side-a'
                              : entry.found.battle.winner === 'b'
                                ? 'side-b'
                                : entry.found.battle.winner === 'tie'
                                  ? 'neutral'
                                  : 'warn'
                          }
                        >
                          {entry.found.battle.winner}
                        </Badge>
                      ) : (
                        <span className="text-2xs text-fg-subtle">no verdict</span>
                      )}
                    </TD>
                    <TD className="text-2xs">
                      {entry.found ? relativeTime(entry.found.battle.createdAt.toISOString()) : '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>

      {cancellable ? (
        <form action={cancelChallengeAction} className="mt-6 flex flex-wrap items-center gap-3">
          <input type="hidden" name="challengeId" value={challenge.id} />
          <button
            type="submit"
            className="inline-flex h-8 items-center rounded-md border border-danger-border bg-danger-subtle px-3 text-xs font-medium text-danger hover:opacity-90"
          >
            Withdraw this challenge
          </button>
          <span className="text-2xs text-fg-subtle">
            Only you can. Battles already uploaded stay exactly where they are.
          </span>
        </form>
      ) : null}

      <p className="mt-6 text-2xs text-fg-subtle">
        <Link href="/docs/challenges" className="text-accent hover:underline">
          What gets linked, and what does not
        </Link>
        .
      </p>
    </Container>
  );
}
