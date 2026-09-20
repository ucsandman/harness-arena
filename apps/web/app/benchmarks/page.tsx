import type { Metadata } from 'next';
import Link from 'next/link';
import { TASK_CATEGORIES } from '@harness-arena/protocol';
import { listBenchmarks } from '@harness-arena/database';
import { EmptyPanel, categoryLabel } from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { getCurrentUser } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { formatUtcDate } from '@/lib/format';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Benchmark packs',
  description:
    'Versioned sets of coding tasks two harnesses can be run against. A pack version is identified by the hash of its content, so a result can never point at a definition that changed.',
  alternates: { canonical: '/benchmarks' },
};

interface PageProps {
  searchParams: Promise<{ category?: string }>;
}

export default async function BenchmarksPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const category = TASK_CATEGORIES.find((item) => item === query.category);

  const dbh = await db();
  const user = await getCurrentUser();
  const packs = await listBenchmarks(dbh, {
    limit: 100,
    viewerUserId: user?.id ?? null,
    ...(category ? { category } : {}),
  });

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="benchmarks"
        title="Benchmark packs"
        description="A pack is a reusable, versioned set of tasks. Arena hosts no runner: a pack expands into ordinary battles that run on your machine with your own agent CLIs, and the catalogue stores the definition."
      />

      <nav aria-label="Benchmark categories" className="mt-6 flex flex-wrap gap-1 border-b border-border">
        <Link
          href="/benchmarks"
          aria-current={category === undefined ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-[0.8125rem] font-medium transition-colors',
            category === undefined
              ? 'border-accent text-fg'
              : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
          )}
        >
          All
        </Link>
        {TASK_CATEGORIES.map((item) => (
          <Link
            key={item}
            href={`/benchmarks?category=${item}`}
            aria-current={item === category ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[0.8125rem] font-medium transition-colors',
              item === category
                ? 'border-accent text-fg'
                : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
            )}
          >
            {categoryLabel(item)}
          </Link>
        ))}
      </nav>

      <div className="mt-4">
        {packs.length === 0 ? (
          <EmptyPanel
            title={category ? `No pack covers ${categoryLabel(category)} yet` : 'No benchmark packs yet'}
            note="A pack is a YAML file. Validate it locally, then publish it with a signed-in CLI; the first account to publish a slug owns it."
          >
            <CodeBlock
              terminal
              code={[
                `${BRAND.cli.bin} benchmark validate ./pack.yaml`,
                `${BRAND.cli.bin} login`,
                `${BRAND.cli.bin} benchmark publish ./pack.yaml`,
              ].join('\n')}
            />
          </EmptyPanel>
        ) : (
          <TableWrap>
            <Table caption="Published benchmark packs">
              <THead>
                <TR>
                  <TH>Pack</TH>
                  <TH>Version</TH>
                  <TH>Categories</TH>
                  <TH className="text-right">Tasks</TH>
                  <TH className="text-right">Battles per run</TH>
                  <TH>Author</TH>
                  <TH>Published</TH>
                </TR>
              </THead>
              <TBody>
                {packs.map((pack) => (
                  <TR key={pack.versionId}>
                    <TD>
                      <Link
                        href={`/benchmarks/${pack.slug}`}
                        className="font-medium hover:text-accent"
                      >
                        {pack.name}
                      </Link>
                      <span className="mt-0.5 block font-mono text-2xs text-fg-subtle">{pack.slug}</span>
                      {pack.description ? (
                        <span className="mt-0.5 block max-w-md truncate text-2xs text-fg-subtle">
                          {pack.description}
                        </span>
                      ) : null}
                    </TD>
                    <TD mono>
                      {pack.version}
                      {pack.visibility !== 'public' ? (
                        <Badge variant="outline" className="ml-1.5">
                          {pack.visibility}
                        </Badge>
                      ) : null}
                    </TD>
                    <TD>
                      {pack.categories.length === 0 ? (
                        <span className="text-2xs text-fg-subtle">overall only</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {pack.categories.map((item) => (
                            <Badge key={item} variant="outline">
                              {categoryLabel(item)}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </TD>
                    <TD mono className="text-right">
                      {pack.taskCount}
                    </TD>
                    <TD mono className="text-right">
                      {pack.battlesPerRun}
                    </TD>
                    <TD mono className="text-2xs">
                      {pack.author ?? 'unattributed'}
                    </TD>
                    <TD>{formatUtcDate(pack.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>

      <p className="mt-4 text-2xs text-fg-subtle">
        &quot;Battles per run&quot; is the sum of each task&apos;s trials: what one full pack run costs you in
        model usage, before you start.
      </p>
    </Container>
  );
}
