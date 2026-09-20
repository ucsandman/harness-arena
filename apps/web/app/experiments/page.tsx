import type { Metadata } from 'next';
import Link from 'next/link';
import { COMPONENT_KIND_LABELS } from '@harness-arena/protocol';
import { listExperiments } from '@harness-arena/database';
import {
  CompetitorLine,
  DeltaText,
  EXPERIMENT_STATUS_VARIANT,
  EmptyPanel,
  EvidenceBadge,
  TargetSummary,
} from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { getCurrentUser } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Experiments',
  description:
    'Control vs treatment over the same tasks: did this harness change actually help? Every summary carries the number of comparable battles it was computed over.',
  alternates: { canonical: '/experiments' },
};

export default async function ExperimentsPage() {
  const dbh = await db();
  const user = await getCurrentUser();
  const experiments = await listExperiments(dbh, { limit: 50, viewerUserId: user?.id ?? null });

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="experiments"
        title="Experiments"
        description="One question each: did this change make the harness better? Control runs as side A, treatment as side B, over the same tasks, and the summary is a pure function of the battle records."
      />

      <div className="mt-6">
        {experiments.length === 0 ? (
          <EmptyPanel
            title="No experiments published yet"
            note="An experiment runs entirely on your machine and is complete offline. Uploading it only adds a page other people can read; the server recomputes the same numbers with the same function."
          >
            <CodeBlock
              terminal
              code={`${BRAND.cli.bin} experiment run --kind regression \\\n  --control https://github.com/you/harness@a1b2c3d \\\n  --treatment https://github.com/you/harness@e4f5a6b \\\n  --benchmark arena-smoke --trials 3`}
            />
          </EmptyPanel>
        ) : (
          <ul className="flex flex-col gap-3">
            {experiments.map((experiment) => (
              <Card as="li" key={experiment.id}>
                <CardHeader>
                  <CardTitle as="h3">
                    <Link href={`/experiments/${experiment.id}`} className="hover:text-accent">
                      {experiment.title}
                    </Link>
                  </CardTitle>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">{experiment.kind}</Badge>
                    <Badge variant={EXPERIMENT_STATUS_VARIANT[experiment.status]}>
                      {experiment.status}
                    </Badge>
                    {experiment.summary ? (
                      <EvidenceBadge evidence={experiment.summary.evidence} />
                    ) : (
                      <Badge variant="unavailable">no summary yet</Badge>
                    )}
                  </span>
                </CardHeader>
                <CardBody className="flex flex-col gap-2.5">
                  <div className="flex flex-col gap-1.5">
                    <CompetitorLine competitor={experiment.control} side="control" />
                    <CompetitorLine competitor={experiment.treatment} side="treatment" />
                  </div>
                  {experiment.changedComponent ? (
                    <span className="flex flex-wrap items-center gap-2 text-2xs text-fg-muted">
                      <Badge variant="neutral">
                        {COMPONENT_KIND_LABELS[experiment.changedComponent.kind]}
                      </Badge>
                      <span className="font-mono">{experiment.changedComponent.name}</span>
                      <span className="text-fg-subtle">is the one thing that changed</span>
                    </span>
                  ) : null}
                  <TargetSummary target={experiment.target} />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-subtle">
                    <span className="font-mono">agent {experiment.agent.id}</span>
                    <span className="font-mono">{experiment.trials} trial(s) per task</span>
                    <span className="font-mono">{experiment.battleIds.length} battle(s)</span>
                    <span>by {experiment.createdBy?.login ?? 'an account that has since been removed'}</span>
                    <span>{relativeTime(experiment.createdAt)}</span>
                  </div>
                  {experiment.summary ? (
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border pt-2.5">
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-2xs uppercase tracking-wide text-fg-muted">correctness</span>
                        <DeltaText value={experiment.summary.correctness.deltaPoints} kind="points" />
                      </span>
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-2xs uppercase tracking-wide text-fg-muted">tokens</span>
                        <DeltaText
                          value={experiment.summary.tokens.deltaPercent}
                          kind="percent"
                          goodWhenNegative
                        />
                      </span>
                      <span className="font-mono text-2xs text-fg-subtle">
                        {experiment.summary.comparable} comparable of {experiment.summary.battles} decided
                      </span>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-6 text-2xs text-fg-subtle">
        Read the sample first and the direction second.{' '}
        <Link href="/docs/experiments" className="text-accent hover:underline">
          How the summary is computed, and how much it is worth
        </Link>
        .
      </p>
    </Container>
  );
}
