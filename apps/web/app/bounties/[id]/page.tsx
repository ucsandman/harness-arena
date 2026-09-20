import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Bounty } from '@harness-arena/protocol';
import { getBounty, listBountySubmissions } from '@harness-arena/database';
import {
  BOUNTY_STATUS_VARIANT,
  BattleLinks,
  CompetitorLine,
  EmptyPanel,
  ExecutionNote,
  TargetSummary,
} from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { absoluteUrl } from '@/lib/env';
import { formatUtcDate, relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const dbh = await db();
  const bounty = await getBounty(dbh, id);
  if (!bounty) return { title: 'Bounty', robots: { index: false, follow: false } };
  return {
    title: bounty.title,
    description:
      bounty.description ??
      `Beat ${bounty.baseline.harness.source} on this task with ${bounty.agent.id}. Arena moves no money; the condition is arithmetic over uploaded battles.`,
    alternates: { canonical: `/bounties/${bounty.id}` },
  };
}

/** The condition, spelled out one requirement per line with the number that decides it. */
function conditionChecklist(bounty: Bounty): string[] {
  const lines = [
    bounty.condition.mustWin === 'every'
      ? 'The submission won EVERY battle linked to it.'
      : 'The submission won more than half of the DECIDED battles linked to it.',
    `At least ${bounty.condition.minBattles} battle(s) are linked to the submission.`,
  ];
  if (bounty.condition.maxTokensRatio !== undefined) {
    lines.push(
      `Tokens: submission / baseline is at most ${bounty.condition.maxTokensRatio} on every battle that reported both sides.`,
    );
  }
  if (bounty.condition.maxCostRatio !== undefined) {
    lines.push(
      `Cost: submission / baseline is at most ${bounty.condition.maxCostRatio} on every battle that reported both sides.`,
    );
  }
  if (bounty.condition.maxDurationRatio !== undefined) {
    lines.push(
      `Duration: submission / baseline is at most ${bounty.condition.maxDurationRatio} on every battle that reported both sides.`,
    );
  }
  return lines;
}

export default async function BountyDetailPage({ params }: PageProps) {
  const { id } = await params;
  const dbh = await db();
  const bounty = await getBounty(dbh, id);
  if (!bounty) notFound();
  const submissions = await listBountySubmissions(dbh, bounty.id);

  const submitCommand = [
    '# 1. register a submission. There is no `arena bounty` command yet, so this is the API.',
    '#    ARENA_TOKEN is the device token `arena login` stored in <ARENA_HOME>/config.json.',
    `curl -s -X POST ${absoluteUrl(`/api/v1/bounties/${bounty.id}/submissions`)} \\`,
    '  -H "authorization: Bearer $ARENA_TOKEN" \\',
    "  -H 'content-type: application/json' \\",
    '  -d \'{"harness":{"source":"https://github.com/you/your-harness"}}\'',
    '',
    '# 2. run the work on your machine. A normal battle whose spec carries',
    '#    arena.bountySubmissionId = the bsb_ id from step 1, and the baseline on the other side.',
    `${BRAND.cli.bin} run submission.json --upload metrics --visibility public`,
  ].join('\n');

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="bounty"
        title={bounty.title}
        description={bounty.description ?? undefined}
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge variant={BOUNTY_STATUS_VARIANT[bounty.status]}>{bounty.status}</Badge>
        <Badge variant="outline" mono>
          {bounty.id}
        </Badge>
        <Badge variant="neutral" mono>
          agent {bounty.agent.id}
        </Badge>
        <span className="text-2xs text-fg-subtle">
          by {bounty.createdBy?.login ?? 'an account that has since been removed'} ·{' '}
          {formatUtcDate(bounty.createdAt)}
          {bounty.deadline ? ` · deadline ${formatUtcDate(bounty.deadline)}` : ' · no deadline'}
        </span>
      </div>

      <ExecutionNote className="mt-6" />

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Baseline to beat</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <CompetitorLine competitor={bounty.baseline} />
            <p className="text-2xs text-fg-subtle">
              Every ratio compares your side to the baseline&apos;s side of the same battle, so machine
              speed and model pricing cancel out.
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Target</CardTitle>
          </CardHeader>
          <CardBody>
            <TargetSummary target={bounty.target} />
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Success condition</CardTitle>
            <span className="text-2xs text-fg-subtle">arithmetic, not judgement</span>
          </CardHeader>
          <CardBody>
            <ul className="flex flex-col gap-2">
              {conditionChecklist(bounty).map((line) => (
                <li key={line} className="flex items-start gap-2 text-[0.8125rem] text-fg-muted">
                  <span className="mt-0.5 font-mono text-2xs text-accent" aria-hidden="true">
                    [ ]
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-2xs text-fg-subtle">
              A check that cannot be evaluated — nobody reported cost on both sides — is not met, and says
              so with the count. Missing evidence is never a pass.
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Reward and eligibility</CardTitle>
            <Badge variant="outline">{bounty.reward.kind}</Badge>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <p className="text-[0.8125rem] text-fg-muted">{bounty.reward.description}</p>
            <p className="text-2xs text-fg-subtle">
              {bounty.reward.kind === 'reputation'
                ? 'Reputation only: the poster says so publicly and nothing changes hands.'
                : 'Settled outside Arena, by the poster, on their own terms. Arena moves no money and is not a party to it.'}
            </p>
            {bounty.eligibility ? (
              <>
                <span className="mt-1 text-2xs uppercase tracking-wide text-fg-muted">Eligibility</span>
                <p className="text-[0.8125rem] text-fg-muted">{bounty.eligibility}</p>
              </>
            ) : (
              <p className="text-2xs text-fg-subtle">No eligibility restrictions were stated.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Enter a submission</CardTitle>
          <span className="text-2xs text-fg-subtle">two steps, both on your machine</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          <CodeBlock terminal code={submitCommand} />
          <p className="text-2xs text-fg-subtle">
            The server re-evaluates the condition from the linked battles every time one is attached, so a
            stored result is never stale, and every check reports the numbers it was decided on.
          </p>
        </CardBody>
      </Card>

      <h2 className="mt-8 text-sm font-semibold">
        Submissions <span className="font-mono text-2xs text-fg-subtle">({submissions.length})</span>
      </h2>
      <div className="mt-3">
        {submissions.length === 0 ? (
          <EmptyPanel
            title="Nobody has entered yet"
            note="A submission is an intent to compete. The battles behind it are run locally and uploaded against its id, and the condition is recomputed each time."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {submissions.map((submission) => (
              <Card as="li" key={submission.id}>
                <CardHeader>
                  <CardTitle as="h3">
                    <CompetitorLine competitor={submission.harness} />
                  </CardTitle>
                  {submission.result ? (
                    <Badge variant={submission.result.met ? 'success' : 'warn'}>
                      {submission.result.met ? 'condition met' : 'not met'}
                    </Badge>
                  ) : (
                    <Badge variant="unavailable">not evaluated yet</Badge>
                  )}
                </CardHeader>
                <CardBody className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-subtle">
                    <span>
                      by {submission.submittedBy?.login ?? 'an account that has since been removed'}
                    </span>
                    <span>{relativeTime(submission.createdAt)}</span>
                    <span className="font-mono">{submission.id}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-2xs uppercase tracking-wide text-fg-muted">battles</span>
                    <BattleLinks ids={submission.battleIds} />
                  </div>
                  {submission.result ? (
                    <ul className="flex flex-col gap-1 border-t border-border pt-2">
                      {submission.result.reasons.map((reason) => (
                        <li key={reason} className="font-mono text-2xs text-fg-muted">
                          {reason}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="border-t border-border pt-2 text-2xs text-fg-subtle">
                      No battle has been linked to this submission yet, so there is nothing to evaluate.
                    </p>
                  )}
                </CardBody>
              </Card>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-6 text-2xs text-fg-subtle">
        <Link href="/docs/challenges" className="text-accent hover:underline">
          The condition table and how each check reports its numbers
        </Link>
        .
      </p>
    </Container>
  );
}
