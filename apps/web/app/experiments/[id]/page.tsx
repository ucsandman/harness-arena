import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  COMPONENT_KIND_LABELS,
  STATS_LOW_SAMPLE,
  type Experiment,
  type MetricDelta,
} from '@harness-arena/protocol';
import { getBattleForViewer, getExperiment } from '@harness-arena/database';
import {
  CompetitorLine,
  DeltaText,
  EXPERIMENT_STATUS_VARIANT,
  EmptyPanel,
  EvidenceBadge,
  RateCell,
  StatsCell,
  TargetSummary,
  categoryLabel,
} from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { getCurrentUser } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { formatDurationShort, formatTokens, formatUsd, relativeTime, shortCommit } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const dbh = await db();
  const experiment = await getExperiment(dbh, id);
  if (!experiment) return { title: 'Experiment', robots: { index: false, follow: false } };
  return {
    title: experiment.title,
    description: `A ${experiment.kind} experiment: control against treatment over the same tasks, with the sample size behind every number.`,
    alternates: { canonical: `/experiments/${experiment.id}` },
    ...(experiment.visibility === 'public' ? {} : { robots: { index: false, follow: false } }),
  };
}

function harnessArg(ref: Experiment['control']): string {
  return ref.harness.commit ? `${ref.harness.source}@${ref.harness.commit}` : ref.harness.source;
}

/** The command that reproduces this experiment, as the CLI actually spells it. */
function reproduceCommand(experiment: Experiment): string {
  const lines = [
    `${BRAND.cli.bin} experiment run \\`,
    `  --kind ${experiment.kind} \\`,
    `  --control ${harnessArg(experiment.control)} \\`,
    `  --treatment ${harnessArg(experiment.treatment)} \\`,
  ];
  if (experiment.target.kind === 'benchmark') {
    lines.push(`  --benchmark ${experiment.target.slug} \\`);
    if (experiment.target.taskId) lines.push(`  --task ${experiment.target.taskId} \\`);
  } else {
    lines.push('  --spec-dir ./specs \\');
  }
  if (experiment.changedComponent) {
    lines.push(
      `  --component ${experiment.changedComponent.kind}:${experiment.changedComponent.name} \\`,
    );
  }
  lines.push(`  --agent ${experiment.agent.id} \\`);
  lines.push(`  --trials ${experiment.trials}`);
  return lines.join('\n');
}

function MetricRow({
  label,
  delta,
  format,
  className,
}: {
  label: string;
  delta: MetricDelta;
  format: (value: number | null | undefined) => string;
  className?: string;
}) {
  return (
    <TR className={className}>
      <TD>{label}</TD>
      <TD>
        <StatsCell stats={delta.control} format={format} />
      </TD>
      <TD>
        <StatsCell stats={delta.treatment} format={format} />
      </TD>
      <TD>
        <DeltaText value={delta.deltaPercent} kind="percent" goodWhenNegative />
      </TD>
      <TD mono className="text-right">
        {delta.n}
      </TD>
    </TR>
  );
}

export default async function ExperimentDetailPage({ params }: PageProps) {
  const { id } = await params;
  const dbh = await db();
  const user = await getCurrentUser();
  const experiment = await getExperiment(dbh, id, user?.id ?? null);
  if (!experiment) notFound();

  const summary = experiment.summary;
  const thin = summary === null;

  const linked = await Promise.all(
    experiment.battleIds.slice(0, 50).map(async (battleId) => ({
      id: battleId,
      found: await getBattleForViewer(dbh, battleId, user?.id ?? null),
    })),
  );

  return (
    <Container className="py-10">
      <SectionHeading eyebrow={`${experiment.kind} experiment`} title={experiment.title} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge variant={EXPERIMENT_STATUS_VARIANT[experiment.status]}>{experiment.status}</Badge>
        <Badge variant="outline" mono>
          {experiment.id}
        </Badge>
        <Badge variant="neutral" mono>
          agent {experiment.agent.id}
        </Badge>
        <Badge variant="neutral" mono>
          {experiment.trials} trial(s) per task
        </Badge>
        {summary ? <EvidenceBadge evidence={summary.evidence} /> : null}
        {experiment.visibility !== 'public' ? (
          <Badge variant="outline">{experiment.visibility}</Badge>
        ) : null}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Control (side A)</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <CompetitorLine competitor={experiment.control} side="control" />
            <span className="font-mono text-2xs text-fg-subtle">
              commit {experiment.control.harness.commit ? shortCommit(experiment.control.harness.commit, 12) : 'not pinned'}
            </span>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Treatment (side B)</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <CompetitorLine competitor={experiment.treatment} side="treatment" />
            <span className="font-mono text-2xs text-fg-subtle">
              commit {experiment.treatment.harness.commit ? shortCommit(experiment.treatment.harness.commit, 12) : 'not pinned'}
            </span>
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>What changed</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {experiment.changedComponent ? (
              <>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="neutral">
                    {COMPONENT_KIND_LABELS[experiment.changedComponent.kind]}
                  </Badge>
                  <Link
                    href={`/components/${experiment.changedComponent.kind}/${experiment.changedComponent.name.toLowerCase()}`}
                    className="font-mono text-[0.8125rem] hover:text-accent"
                  >
                    {experiment.changedComponent.name}
                  </Link>
                </span>
                {experiment.changedComponent.description ? (
                  <p className="text-2xs text-fg-muted">{experiment.changedComponent.description}</p>
                ) : null}
                {experiment.changedComponent.path ? (
                  <span className="font-mono text-2xs text-fg-subtle">
                    {experiment.changedComponent.path}
                  </span>
                ) : null}
              </>
            ) : (
              <p className="text-2xs text-fg-muted">
                No single component is named. A {experiment.kind} does not require one; only an ablation
                does, and that is what lets the component catalogue carry evidence.
              </p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Target</CardTitle>
          </CardHeader>
          <CardBody>
            <TargetSummary target={experiment.target} />
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Reproduce it</CardTitle>
          <span className="text-2xs text-fg-subtle">runs on your machine</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          <CodeBlock terminal code={reproduceCommand(experiment)} />
          {experiment.target.kind === 'task' ? (
            <p className="text-2xs text-fg-subtle">
              This experiment ran an inline task rather than a published pack, so there is nothing in the
              catalogue to fetch: supply the same spec locally with{' '}
              <span className="font-mono">--spec-dir</span>.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {thin ? (
        <EmptyPanel
          className="mt-6"
          title="Not enough evidence to conclude anything"
          note={
            summary === null
              ? 'This experiment has no summary yet: it is still running, or no battle has been linked to it.'
              : `${summary.comparable} comparable battle(s) is below the ${STATS_LOW_SAMPLE} needed for even a weak conclusion. The numbers below are what happened; they are not a result.`
          }
        />
      ) : null}

      {summary ? (
        <>
          <h2 className="mt-8 text-sm font-semibold">Wins</h2>
          <p className="mt-1 text-2xs text-fg-subtle">
            {summary.battles} battle(s) reached a verdict; {summary.comparable} had both sides complete, so
            only those {summary.comparable} contribute to the metric deltas below.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            {[
              { label: 'control wins', value: summary.wins.control },
              { label: 'treatment wins', value: summary.wins.treatment },
              { label: 'ties', value: summary.wins.ties },
              { label: 'inconclusive', value: summary.wins.inconclusive },
            ].map((entry) => (
              <div key={entry.label} className="rounded-card border border-border bg-surface px-4 py-3">
                <span className="block text-2xs font-medium uppercase tracking-wide text-fg-muted">
                  {entry.label}
                </span>
                <span className="mt-0.5 block font-mono text-lg font-semibold tabular-nums">
                  {entry.value}
                </span>
              </div>
            ))}
          </div>

          <h2 className="mt-8 text-sm font-semibold">Correctness</h2>
          <p className="mt-1 max-w-3xl text-2xs text-fg-subtle">
            A side is correct on a battle when it passed every correctness gate that actually ran. The rate
            carries a Wilson interval, which stays honest on a small sample instead of collapsing to a
            point. Efficiency is deliberately not part of this.
          </p>
          <div className="mt-3">
            <TableWrap>
              <Table caption="Correctness, control against treatment">
                <THead>
                  <TR>
                    <TH>Control</TH>
                    <TH>Treatment</TH>
                    <TH>Delta</TH>
                  </TR>
                </THead>
                <TBody>
                  <TR>
                    <TD>
                      <RateCell rate={summary.correctness.control} />
                    </TD>
                    <TD>
                      <RateCell rate={summary.correctness.treatment} />
                    </TD>
                    <TD>
                      <DeltaText value={summary.correctness.deltaPoints} kind="points" />
                    </TD>
                  </TR>
                </TBody>
              </Table>
            </TableWrap>
          </div>

          <h2 className="mt-8 text-sm font-semibold">Tokens, cost and duration</h2>
          <p className="mt-1 max-w-3xl text-2xs text-fg-subtle">
            Paired per battle: a battle contributes only when both sides report a value the adapter observed
            or calculated. Estimated and unavailable values are excluded, so `n` is usually below the battle
            count.
          </p>
          <div className="mt-3">
            <TableWrap>
              <Table caption="Efficiency metrics, control against treatment">
                <THead>
                  <TR>
                    <TH>Metric</TH>
                    <TH>Control</TH>
                    <TH>Treatment</TH>
                    <TH>Delta</TH>
                    <TH className="text-right">Paired n</TH>
                  </TR>
                </THead>
                <TBody>
                  <MetricRow label="Tokens" delta={summary.tokens} format={formatTokens} />
                  <MetricRow label="Cost" delta={summary.cost} format={formatUsd} />
                  <MetricRow label="Duration" delta={summary.duration} format={formatDurationShort} />
                </TBody>
              </Table>
            </TableWrap>
          </div>

          {summary.byCategory.length > 0 ? (
            <>
              <h2 className="mt-8 text-sm font-semibold">By category</h2>
              <div className="mt-3">
                <TableWrap>
                  <Table caption="Correctness per category">
                    <THead>
                      <TR>
                        <TH>Category</TH>
                        <TH className="text-right">Battles</TH>
                        <TH>Control</TH>
                        <TH>Treatment</TH>
                        <TH>Delta</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {summary.byCategory.map((entry) => (
                        <TR key={entry.category}>
                          <TD>{categoryLabel(entry.category)}</TD>
                          <TD mono className="text-right">
                            {entry.battles}
                          </TD>
                          <TD>
                            <RateCell rate={entry.correctness.control} />
                          </TD>
                          <TD>
                            <RateCell rate={entry.correctness.treatment} />
                          </TD>
                          <TD>
                            <DeltaText value={entry.correctness.deltaPoints} kind="points" />
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              </div>
            </>
          ) : null}

          <h2 className="mt-8 text-sm font-semibold">Evidence</h2>
          <div className="mt-3 rounded-card border border-border bg-surface px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <EvidenceBadge evidence={summary.evidence} />
              <span className="text-2xs text-fg-muted">{summary.evidence.rationale}</span>
            </div>
            {summary.conclusions.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-1.5">
                {summary.conclusions.map((conclusion) => (
                  <li key={conclusion} className="text-[0.8125rem] leading-relaxed text-fg-muted">
                    {conclusion}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-2xs text-fg-subtle">
                No conclusion was generated: the numbers above did not clear the sample the generator
                requires for a sentence.
              </p>
            )}
          </div>
        </>
      ) : null}

      <h2 className="mt-8 text-sm font-semibold">Linked battles</h2>
      <div className="mt-3">
        {linked.length === 0 ? (
          <EmptyPanel
            title="No battle is linked yet"
            note="The server links a battle only after checking it really ran this control against this treatment. A mismatched battle is stored and refused for the experiment, with the reason."
          />
        ) : (
          <TableWrap>
            <Table caption="Battles linked to this experiment">
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
                    <TD mono className="text-2xs">
                      {entry.found?.battle.winner ?? 'no verdict'}
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

      <p className="mt-6 text-2xs text-fg-subtle">
        Ratings move only on public, completed, non-demo battles that pass the integrity checks. An
        experiment is evidence, not a score.{' '}
        <Link href="/docs/experiments" className="text-accent hover:underline">
          One run proves nothing
        </Link>
        .
      </p>
    </Container>
  );
}
