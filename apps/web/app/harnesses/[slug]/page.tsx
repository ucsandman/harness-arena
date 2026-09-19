import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RATING_CATEGORY_LABELS, RATING_MIN_SAMPLE, type RatingCategory } from '@harness-arena/protocol';
import { getHarnessProfile } from '@harness-arena/database';
import { BattleList } from '@/components/battles/BattleList';
import { InspectionCard } from '@/components/harness/InspectionCard';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { formatUtcDate, shortCommit } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ saved?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const dbh = await db();
  const profile = await getHarnessProfile(dbh, slug);
  if (!profile) return { title: 'Harness', robots: { index: false, follow: false } };
  return {
    title: profile.harness.name,
    description:
      profile.harness.description ??
      `${profile.harness.name}: a ${profile.harness.framework} harness, with its detected features, versions and public battles.`,
    alternates: { canonical: `/harnesses/${slug}` },
  };
}

function categoryLabel(category: string): string {
  return RATING_CATEGORY_LABELS[category as RatingCategory] ?? category;
}

export default async function HarnessProfilePage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { saved } = await searchParams;
  const dbh = await db();
  const profile = await getHarnessProfile(dbh, slug);
  if (!profile) notFound();

  const { harness, versions, recentBattles, ratings } = profile;
  const latestInspection = versions.find((version) => version.inspection !== null)?.inspection ?? null;
  const community = ratings.filter((rating) => rating.pool === 'community');
  const verified = ratings.filter((rating) => rating.pool === 'verified');

  return (
    <Container className="py-10">
      {saved === '1' ? (
        <p className="mb-4 rounded-card border border-success-border bg-success-subtle px-4 py-2.5 text-[0.8125rem] text-success">
          Saved. This harness is now in the catalog with its inspection.
        </p>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{harness.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-fg-muted">
            <Badge variant="outline">{harness.framework}</Badge>
            <span className="font-mono">{harness.slug}</span>
            {harness.sourceUrl ? (
              <a
                href={harness.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent hover:underline"
              >
                {harness.sourceUrl.replace(/^https?:\/\//, '')}
              </a>
            ) : (
              <span className="font-mono">{harness.sourceKind}</span>
            )}
          </p>
          {harness.description ? (
            <p className="mt-2 max-w-2xl text-[0.9375rem] text-fg-muted">{harness.description}</p>
          ) : null}
        </div>
        <Button href="/battles/new" size="sm" variant="secondary">
          Battle this harness
        </Button>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Battle it</CardTitle>
        </CardHeader>
        <CardBody>
          <CodeBlock
            terminal
            code={`${BRAND.cli.bin} battle --task "Fix the failing test" --a vanilla --b ${harness.sourceUrl ?? harness.slug}`}
          />
        </CardBody>
      </Card>

      <div className="mt-4">
        {latestInspection ? (
          <InspectionCard inspection={latestInspection} title={harness.name} sourceUrl={harness.sourceUrl} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>No inspection yet</CardTitle>
            </CardHeader>
            <CardBody className="text-[0.8125rem] text-fg-muted">
              This harness was discovered from a battle, so Arena has its identity and manifest but has not
              inspected the repository. Import it from{' '}
              <a href="/harnesses/import" className="text-accent hover:underline">
                /harnesses/import
              </a>{' '}
              to fill in the feature grid.
            </CardBody>
          </Card>
        )}
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Versions</CardTitle>
          <span className="text-2xs text-fg-subtle">One row per commit Arena has seen.</span>
        </CardHeader>
        <div className="border-t border-border">
          {versions.length === 0 ? (
            <p className="px-4 py-3 text-[0.8125rem] text-fg-muted">No versions recorded.</p>
          ) : (
            <TableWrap>
              <Table caption="Harness versions">
                <THead>
                  <TR>
                    <TH>Commit</TH>
                    <TH>arena.yaml</TH>
                    <TH>Inspected</TH>
                    <TH>Seen</TH>
                  </TR>
                </THead>
                <TBody>
                  {versions.map((version) => (
                    <TR key={version.id}>
                      <TD mono>{version.commit ? shortCommit(version.commit, 10) : 'unpinned'}</TD>
                      <TD>
                        {version.manifest ? (
                          <span className="font-mono text-2xs">
                            {version.manifest.name}
                            {version.manifest.version ? ` v${version.manifest.version}` : ''}
                          </span>
                        ) : (
                          <span className="text-2xs text-fg-subtle">auto-detected</span>
                        )}
                      </TD>
                      <TD>{version.inspection ? 'yes' : 'no'}</TD>
                      <TD>{formatUtcDate(version.createdAt.toISOString())}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </div>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Ratings</CardTitle>
          <span className="text-2xs text-fg-subtle">
            Community pool only until verified cloud battles exist.
          </span>
        </CardHeader>
        <div className="border-t border-border">
          {community.length === 0 ? (
            <p className="px-4 py-3 text-[0.8125rem] text-fg-muted">
              No decided battles yet, so this harness has no rating. Elo moves only on a battle with a winner.
            </p>
          ) : (
            <TableWrap>
              <Table caption="Community ratings">
                <THead>
                  <TR>
                    <TH>Category</TH>
                    <TH>Agent</TH>
                    <TH className="text-right">Rating</TH>
                    <TH className="text-right">Battles</TH>
                    <TH className="text-right">W / L / T</TH>
                    <TH>Sample</TH>
                  </TR>
                </THead>
                <TBody>
                  {community.map((rating) => (
                    <TR key={`${rating.category}-${rating.agentId}`}>
                      <TD>{categoryLabel(rating.category)}</TD>
                      <TD mono>{rating.agentId}</TD>
                      <TD mono className="text-right">
                        {Math.round(rating.rating)}
                        <span className="text-fg-subtle"> ±{Math.round(rating.deviation)}</span>
                      </TD>
                      <TD mono className="text-right">
                        {rating.battles}
                      </TD>
                      <TD mono className="text-right">
                        {rating.wins} / {rating.losses} / {rating.ties}
                      </TD>
                      <TD>
                        {rating.provisional ? (
                          <Badge variant="warn">provisional</Badge>
                        ) : (
                          <Badge variant="success">ranked</Badge>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
          <p className="border-t border-border px-4 py-2.5 text-2xs text-fg-subtle">
            Provisional below {RATING_MIN_SAMPLE} decided battles. Community results are self-reported local
            battles and never enter the verified pool
            {verified.length > 0
              ? ` (${verified.length} verified rows exist)`
              : ' (no verified battles exist yet)'}
            .
          </p>
        </div>
      </Card>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold">Recent public battles</h2>
        <BattleList
          battles={recentBattles}
          empty={
            <p className="rounded-card border border-border bg-surface px-4 py-3 text-[0.8125rem] text-fg-muted">
              No public battles reference this harness yet.
            </p>
          }
        />
      </section>
    </Container>
  );
}
