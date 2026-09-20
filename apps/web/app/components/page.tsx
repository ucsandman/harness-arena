import type { Metadata } from 'next';
import Link from 'next/link';
import { COMPONENT_KIND_LABELS, componentKindSchema, type ComponentKind } from '@harness-arena/protocol';
import { listComponents } from '@harness-arena/database';
import { DeltaText, EmptyPanel } from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { db } from '@/lib/db';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Components',
  description:
    'The reusable parts a harness declares — skills, hooks, MCP servers, subagents, instructions — and what experiments have actually measured about each one.',
  alternates: { canonical: '/components' },
};

interface PageProps {
  searchParams: Promise<{ kind?: string }>;
}

export default async function ComponentsPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const kind: ComponentKind | undefined = componentKindSchema.safeParse(query.kind).data;

  const dbh = await db();
  const components = await listComponents(dbh, { limit: 100, ...(kind ? { kind } : {}) });

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="components"
        title="Components"
        description="A component is a reusable part of a harness, declared in its arena.yaml. Evidence is never asserted: a component's numbers are the mean of the experiment summaries that name it as the one thing that changed."
      />

      <nav aria-label="Component kinds" className="mt-6 flex flex-wrap gap-1 border-b border-border">
        <Link
          href="/components"
          aria-current={kind === undefined ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-[0.8125rem] font-medium transition-colors',
            kind === undefined
              ? 'border-accent text-fg'
              : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
          )}
        >
          All
        </Link>
        {componentKindSchema.options.map((option) => (
          <Link
            key={option}
            href={`/components?kind=${option}`}
            aria-current={option === kind ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[0.8125rem] font-medium transition-colors',
              option === kind
                ? 'border-accent text-fg'
                : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
            )}
          >
            {COMPONENT_KIND_LABELS[option]}
          </Link>
        ))}
      </nav>

      <div className="mt-4">
        {components.length === 0 ? (
          <EmptyPanel
            title={kind ? `No ${COMPONENT_KIND_LABELS[kind]} component yet` : 'No components catalogued yet'}
            note="Components appear here when a harness declares them in its arena.yaml and a battle or an import records that commit. Nothing is inferred from file names."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {components.map((component) => (
              <Card as="li" key={component.slug} className="flex flex-col">
                <CardHeader>
                  <CardTitle as="h3">
                    <Link href={`/components/${component.slug}`} className="hover:text-accent">
                      {component.name}
                    </Link>
                  </CardTitle>
                  <Badge variant="outline">{COMPONENT_KIND_LABELS[component.kind]}</Badge>
                </CardHeader>
                <CardBody className="flex flex-1 flex-col gap-2">
                  {component.description ? (
                    <p className="text-2xs text-fg-muted">{component.description}</p>
                  ) : null}
                  {component.source ? (
                    <span className="truncate font-mono text-2xs text-fg-subtle">{component.source}</span>
                  ) : (
                    <span className="font-mono text-2xs text-fg-subtle">no source declared</span>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-subtle">
                    <span className="font-mono">{component.harnesses} harness(es)</span>
                    <span className="font-mono">{component.evidence.experiments} experiment(s)</span>
                  </div>
                  <div className="mt-auto border-t border-border pt-2">
                    {component.evidence.summarized === 0 ? (
                      <span className="text-2xs text-fg-subtle">No experiment evidence yet.</span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-2xs uppercase tracking-wide text-fg-muted">correctness</span>
                          <DeltaText value={component.evidence.correctnessDeltaPoints} kind="points" />
                        </span>
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-2xs uppercase tracking-wide text-fg-muted">tokens</span>
                          <DeltaText
                            value={component.evidence.tokenDeltaPercent}
                            kind="percent"
                            goodWhenNegative
                          />
                        </span>
                        <span className="font-mono text-2xs text-fg-subtle">
                          mean over n={component.evidence.summarized} summarised experiment(s)
                        </span>
                      </div>
                    )}
                  </div>
                </CardBody>
              </Card>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-6 text-2xs text-fg-subtle">
        A component nobody has experimented on reports nothing rather than a zero.{' '}
        <Link href="/docs/lineage" className="text-accent hover:underline">
          How a component earns evidence
        </Link>
        .
      </p>
    </Container>
  );
}
