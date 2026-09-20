import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { COMPONENT_KIND_LABELS } from '@harness-arena/protocol';
import { getComponent, getExperiment } from '@harness-arena/database';
import { DeltaText, EXPERIMENT_STATUS_VARIANT, EmptyPanel } from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { db } from '@/lib/db';
import { formatUtcDate, shortCommit } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string[] }>;
}

/** `<kind>/<name>`, lowercased: exactly the catalogue key componentSlug() writes. */
function slugFrom(parts: readonly string[]): string {
  return parts.join('/').toLowerCase();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const dbh = await db();
  const component = await getComponent(dbh, slugFrom(slug));
  if (!component) return { title: 'Component', robots: { index: false, follow: false } };
  return {
    title: `${component.name} (${COMPONENT_KIND_LABELS[component.kind]})`,
    description:
      component.description ??
      `A ${COMPONENT_KIND_LABELS[component.kind].toLowerCase()} declared by ${component.harnesses} harness(es), with the experiment evidence behind it.`,
    alternates: { canonical: `/components/${component.slug}` },
  };
}

export default async function ComponentDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const dbh = await db();
  const component = await getComponent(dbh, slugFrom(slug));
  if (!component) notFound();

  // the catalogue row carries each experiment's headline numbers but not its sentences; the
  // conclusions are the part a reader can actually act on, so they are read per experiment
  const experiments = await Promise.all(
    component.experimentList.slice(0, 20).map(async (entry) => ({
      entry,
      full: await getExperiment(dbh, entry.id),
    })),
  );

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow={COMPONENT_KIND_LABELS[component.kind].toLowerCase()}
        title={component.name}
        description={component.description ?? undefined}
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge variant="outline">{COMPONENT_KIND_LABELS[component.kind]}</Badge>
        <Badge variant="neutral" mono>
          {component.slug}
        </Badge>
        {component.source ? (
          <span className="font-mono text-2xs text-fg-subtle">{component.source}</span>
        ) : (
          <span className="font-mono text-2xs text-fg-subtle">no source declared</span>
        )}
        <span className="text-2xs text-fg-subtle">first seen {formatUtcDate(component.createdAt)}</span>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Evidence</CardTitle>
          <span className="font-mono text-2xs text-fg-subtle">
            {component.evidence.experiments} experiment(s), {component.evidence.summarized} summarised
          </span>
        </CardHeader>
        <CardBody>
          {component.evidence.summarized === 0 ? (
            <p className="text-[0.8125rem] text-fg-muted">
              Nobody has measured this component yet. An ablation that names it as the one thing that
              changed is what puts a number here; until then there is nothing to report, and a zero would be
              a lie.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
              <span className="flex items-baseline gap-2">
                <span className="text-2xs uppercase tracking-wide text-fg-muted">correctness</span>
                <DeltaText value={component.evidence.correctnessDeltaPoints} kind="points" />
              </span>
              <span className="flex items-baseline gap-2">
                <span className="text-2xs uppercase tracking-wide text-fg-muted">tokens</span>
                <DeltaText value={component.evidence.tokenDeltaPercent} kind="percent" goodWhenNegative />
              </span>
              <span className="font-mono text-2xs text-fg-subtle">
                mean over n={component.evidence.summarized} completed experiment(s)
              </span>
            </div>
          )}
        </CardBody>
      </Card>

      <h2 className="mt-8 text-sm font-semibold">Harness versions that declare it</h2>
      <div className="mt-3">
        {component.harnessList.length === 0 ? (
          <EmptyPanel
            title="No harness version declares it"
            note="A component row can exist from an experiment alone. It is attached to a harness version when that version's arena.yaml lists it."
          />
        ) : (
          <TableWrap>
            <Table caption={`Harness versions declaring ${component.slug}`}>
              <THead>
                <TR>
                  <TH>Harness</TH>
                  <TH>Commit</TH>
                  <TH>Path</TH>
                </TR>
              </THead>
              <TBody>
                {component.harnessList.map((harness, index) => (
                  <TR key={`${harness.slug}-${harness.commit ?? index}`}>
                    <TD>
                      <Link href={`/harnesses/${harness.slug}`} className="font-medium hover:text-accent">
                        {harness.name}
                      </Link>
                    </TD>
                    <TD mono className="text-2xs">
                      {harness.commit ? shortCommit(harness.commit, 12) : 'not pinned'}
                    </TD>
                    <TD mono className="text-2xs">
                      {harness.path ?? 'not recorded'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>

      <h2 className="mt-8 text-sm font-semibold">Experiments that changed it</h2>
      <div className="mt-3">
        {experiments.length === 0 ? (
          <EmptyPanel
            title="No experiment names it"
            note="Run an ablation with --component to produce evidence: control is the harness without it, treatment is the harness with it, over the same tasks."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {experiments.map(({ entry, full }) => (
              <Card as="li" key={entry.id}>
                <CardHeader>
                  <CardTitle as="h3">
                    <Link href={`/experiments/${entry.id}`} className="hover:text-accent">
                      {entry.title}
                    </Link>
                  </CardTitle>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">{entry.kind}</Badge>
                    <Badge variant={EXPERIMENT_STATUS_VARIANT[entry.status]}>{entry.status}</Badge>
                  </span>
                </CardHeader>
                <CardBody className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-2xs uppercase tracking-wide text-fg-muted">correctness</span>
                      <DeltaText value={entry.correctnessDeltaPoints} kind="points" />
                    </span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-2xs uppercase tracking-wide text-fg-muted">tokens</span>
                      <DeltaText value={entry.tokenDeltaPercent} kind="percent" goodWhenNegative />
                    </span>
                    <span className="font-mono text-2xs text-fg-subtle">
                      {entry.battles} linked battle(s) · {formatUtcDate(entry.createdAt)}
                    </span>
                  </div>
                  {full?.summary && full.summary.conclusions.length > 0 ? (
                    <ul className="flex flex-col gap-1 border-t border-border pt-2">
                      {full.summary.conclusions.map((conclusion) => (
                        <li key={conclusion} className="text-2xs leading-relaxed text-fg-muted">
                          {conclusion}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="border-t border-border pt-2 text-2xs text-fg-subtle">
                      No conclusion yet: this experiment has no stored summary, or its sample was too small
                      for a sentence.
                    </p>
                  )}
                </CardBody>
              </Card>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-6 text-2xs text-fg-subtle">
        <Link href="/docs/lineage" className="text-accent hover:underline">
          Lineage and components
        </Link>
        .
      </p>
    </Container>
  );
}
