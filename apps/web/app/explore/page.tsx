import type { Metadata } from 'next';
import Link from 'next/link';
import {
  COMPONENT_KIND_LABELS,
  RATING_CATEGORIES,
  RATING_CATEGORY_LABELS,
  RATING_MIN_SAMPLE,
  ratingCategorySchema,
  ratingPoolSchema,
  type RatingCategory,
  type RatingPool,
} from '@harness-arena/protocol';
import {
  AGENT_CATALOG,
  listBenchmarks,
  listChallenges,
  listComponents,
  listTournaments,
} from '@harness-arena/database';
import {
  CHALLENGE_STATUS_VARIANT,
  DeltaText,
  EmptyPanel,
  ExecutionNote,
  TOURNAMENT_STATUS_VARIANT,
  categoryLabel,
} from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { EXPLORE_RISING_DAYS, exploreRankings, isProvisionalSample } from '@/lib/explore';
import { db } from '@/lib/db';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Explore',
  description:
    'Discover harnesses, benchmark packs, challenges, tournaments and components: what is rated, what is rising, what has actually been tested, and what has evidence behind it.',
  alternates: { canonical: '/explore' },
};

interface PageProps {
  searchParams: Promise<{ agent?: string; category?: string; pool?: string; minBattles?: string }>;
}

const MIN_BATTLE_CHOICES = [0, 1, RATING_MIN_SAMPLE, 30] as const;

function FilterLinks({
  label,
  options,
  current,
  href,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; text: string }>;
  current: string;
  href: (value: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">{label}</span>
      {options.map((option) => (
        <Link
          key={option.value}
          href={href(option.value)}
          aria-current={option.value === current ? 'true' : undefined}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-2xs font-medium',
            option.value === current
              ? 'border-accent-border bg-accent-subtle text-accent'
              : 'border-border text-fg-muted hover:bg-bg-subtle hover:text-fg',
          )}
        >
          {option.text}
        </Link>
      ))}
    </div>
  );
}

export default async function ExplorePage({ searchParams }: PageProps) {
  const query = await searchParams;
  const category: RatingCategory = ratingCategorySchema.safeParse(query.category).data ?? 'overall';
  const pool: RatingPool = ratingPoolSchema.safeParse(query.pool).data ?? 'community';
  const agentId = query.agent && query.agent in AGENT_CATALOG ? query.agent : undefined;
  const parsedMin = Number(query.minBattles);
  const minBattles = Number.isFinite(parsedMin) && parsedMin > 0 ? Math.floor(parsedMin) : 0;

  const href = (overrides: Partial<Record<'agent' | 'category' | 'pool' | 'minBattles', string>>) => {
    const params = new URLSearchParams();
    const merged = {
      agent: agentId ?? '',
      category,
      pool,
      minBattles: String(minBattles),
      ...overrides,
    };
    if (merged.agent) params.set('agent', merged.agent);
    if (merged.category !== 'overall') params.set('category', merged.category);
    if (merged.pool !== 'community') params.set('pool', merged.pool);
    if (merged.minBattles !== '0') params.set('minBattles', merged.minBattles);
    const qs = params.toString();
    return qs ? `/explore?${qs}` : '/explore';
  };

  const dbh = await db();
  const [rankings, challenges, packs, tournaments, components] = await Promise.all([
    exploreRankings(dbh, { category, pool, minBattles, ...(agentId ? { agentId } : {}) }),
    listChallenges(dbh, { status: 'open', limit: 5 }),
    listBenchmarks(dbh, { limit: 5 }),
    listTournaments(dbh, { limit: 5 }),
    listComponents(dbh, { limit: 6 }),
  ]);

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="explore"
        title="Explore"
        description="Everything Arena knows, in one place: what is rated, what is rising, what has actually been tested, and what has evidence behind it. Every number carries the sample it came from."
      />

      <div className="mt-6 flex flex-col gap-3 rounded-card border border-border bg-surface px-4 py-3.5">
        <FilterLinks
          label="Agent"
          current={agentId ?? ''}
          href={(value) => href({ agent: value })}
          options={[
            { value: '', text: 'any' },
            ...Object.entries(AGENT_CATALOG).map(([id, entry]) => ({ value: id, text: entry.displayName })),
          ]}
        />
        <FilterLinks
          label="Category"
          current={category}
          href={(value) => href({ category: value })}
          options={RATING_CATEGORIES.map((item) => ({ value: item, text: RATING_CATEGORY_LABELS[item] }))}
        />
        <FilterLinks
          label="Pool"
          current={pool}
          href={(value) => href({ pool: value })}
          options={ratingPoolSchema.options.map((item) => ({ value: item, text: item }))}
        />
        <FilterLinks
          label="Min battles"
          current={String(minBattles)}
          href={(value) => href({ minBattles: value })}
          options={MIN_BATTLE_CHOICES.map((value) => ({ value: String(value), text: String(value) }))}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top harnesses</CardTitle>
            <span className="font-mono text-2xs text-fg-subtle">
              {categoryLabel(category)} · {pool} · {rankings.scanned} rated row(s) scanned
            </span>
          </CardHeader>
          <CardBody>
            {rankings.top.length === 0 ? (
              <p className="text-2xs text-fg-subtle">
                Nothing is rated in {categoryLabel(category)} for this filter yet. Ratings move only on a
                public battle with a decided winner.
              </p>
            ) : (
              <TableWrap>
                <Table caption="Top rated harnesses for this filter">
                  <THead>
                    <TR>
                      <TH className="text-right">#</TH>
                      <TH>Harness</TH>
                      <TH>Agent</TH>
                      <TH className="text-right">Rating</TH>
                      <TH className="text-right">Battles</TH>
                      <TH>Sample</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rankings.top.map((row, index) => (
                      <TR key={`${row.harnessId}-${row.agentId}`}>
                        <TD mono className="text-right">
                          {isProvisionalSample(row) ? '—' : index + 1}
                        </TD>
                        <TD>
                          <Link
                            href={`/harnesses/${row.harnessSlug}`}
                            className="font-medium hover:text-accent"
                          >
                            {row.harnessName}
                          </Link>
                        </TD>
                        <TD mono className="text-2xs">
                          {row.agentId}
                        </TD>
                        <TD mono className="text-right">
                          {Math.round(row.rating)}
                          <span className="text-fg-subtle"> ±{Math.round(row.deviation)}</span>
                        </TD>
                        <TD mono className="text-right">
                          {row.battles}
                        </TD>
                        <TD>
                          {isProvisionalSample(row) ? (
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
            <p className="mt-2 text-2xs text-fg-subtle">
              Below {RATING_MIN_SAMPLE} decided battles a rating is provisional and never numbered.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Rising</CardTitle>
            <span className="font-mono text-2xs text-fg-subtle">
              last {EXPLORE_RISING_DAYS} days · {rankings.risingScanned} harness(es) read
            </span>
          </CardHeader>
          <CardBody>
            {rankings.rising.length === 0 ? (
              <p className="text-2xs text-fg-subtle">
                No rating moved upward in the last {EXPLORE_RISING_DAYS} days under this filter. That is a
                real answer, not an empty list waiting to fill.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {rankings.rising.map((entry) => (
                  <li key={entry.slug} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <Link
                      href={`/harnesses/${entry.slug}`}
                      className="text-[0.8125rem] font-medium hover:text-accent"
                    >
                      {entry.name}
                    </Link>
                    <span className="font-mono text-xs font-medium tabular-nums text-success">
                      +{entry.delta}
                    </span>
                    <span className="font-mono text-2xs text-fg-subtle">
                      over {entry.events} rating event(s) · now {Math.round(entry.rating)} ·{' '}
                      {entry.battles} battle(s)
                    </span>
                    {entry.provisional ? <Badge variant="warn">provisional</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Most tested</CardTitle>
            <span className="font-mono text-2xs text-fg-subtle">by decided rated battles</span>
          </CardHeader>
          <CardBody>
            {rankings.mostTested.length === 0 ? (
              <p className="text-2xs text-fg-subtle">
                Nothing has been rated under this filter yet, so there is nothing to count.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {rankings.mostTested.map((row) => (
                  <li
                    key={`${row.harnessId}-${row.agentId}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
                  >
                    <Link
                      href={`/harnesses/${row.harnessSlug}`}
                      className="text-[0.8125rem] font-medium hover:text-accent"
                    >
                      {row.harnessName}
                    </Link>
                    <span className="font-mono text-xs tabular-nums">{row.battles}</span>
                    <span className="font-mono text-2xs text-fg-subtle">
                      {row.wins}W / {row.losses}L / {row.ties}T on {row.agentId}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open challenges</CardTitle>
            <Link href="/challenges" className="text-2xs text-accent hover:underline">
              all challenges
            </Link>
          </CardHeader>
          <CardBody>
            {challenges.length === 0 ? (
              <p className="text-2xs text-fg-subtle">
                Nothing open. A challenge carries its own task, so accepting one never means trusting a
                description.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {challenges.map((challenge) => (
                  <li key={challenge.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <Link
                      href={`/challenges/${challenge.id}`}
                      className="text-[0.8125rem] font-medium hover:text-accent"
                    >
                      {challenge.title}
                    </Link>
                    <Badge variant={CHALLENGE_STATUS_VARIANT[challenge.status]}>{challenge.status}</Badge>
                    <span className="font-mono text-2xs text-fg-subtle">
                      {challenge.agent.id} · {relativeTime(challenge.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Benchmark packs</CardTitle>
            <Link href="/benchmarks" className="text-2xs text-accent hover:underline">
              all packs
            </Link>
          </CardHeader>
          <CardBody>
            {packs.length === 0 ? (
              <p className="text-2xs text-fg-subtle">
                No pack is published yet. A pack is a YAML file; publishing one is two commands.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {packs.map((pack) => (
                  <li key={pack.versionId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <Link
                      href={`/benchmarks/${pack.slug}`}
                      className="text-[0.8125rem] font-medium hover:text-accent"
                    >
                      {pack.name}
                    </Link>
                    <span className="font-mono text-2xs text-fg-subtle">
                      v{pack.version} · {pack.taskCount} task(s) · {pack.battlesPerRun} battle(s) per run
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tournaments</CardTitle>
            <Link href="/tournaments" className="text-2xs text-accent hover:underline">
              all tournaments
            </Link>
          </CardHeader>
          <CardBody>
            {tournaments.length === 0 ? (
              <p className="text-2xs text-fg-subtle">
                No bracket has been built. A tournament needs 2 to 64 entrants and contributors willing to
                run the matches locally.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {tournaments.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <Link
                      href={`/tournaments/${entry.slug}`}
                      className="text-[0.8125rem] font-medium hover:text-accent"
                    >
                      {entry.name}
                    </Link>
                    <Badge variant={TOURNAMENT_STATUS_VARIANT[entry.status]}>{entry.status}</Badge>
                    <span className="font-mono text-2xs text-fg-subtle">
                      {entry.entrants} entrants · {entry.rounds} round(s)
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Components</CardTitle>
            <Link href="/components" className="text-2xs text-accent hover:underline">
              all components
            </Link>
          </CardHeader>
          <CardBody>
            {components.length === 0 ? (
              <p className="text-2xs text-fg-subtle">
                Nothing catalogued. Components appear when a harness declares them in its arena.yaml.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {components.map((component) => (
                  <li key={component.slug} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <Link
                      href={`/components/${component.slug}`}
                      className="text-[0.8125rem] font-medium hover:text-accent"
                    >
                      {component.name}
                    </Link>
                    <Badge variant="outline">{COMPONENT_KIND_LABELS[component.kind]}</Badge>
                    {component.evidence.summarized === 0 ? (
                      <span className="text-2xs text-fg-subtle">no experiment evidence yet</span>
                    ) : (
                      <span className="flex items-baseline gap-1.5">
                        <DeltaText value={component.evidence.correctnessDeltaPoints} kind="points" />
                        <span className="font-mono text-2xs text-fg-subtle">
                          n={component.evidence.summarized}
                        </span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <ExecutionNote className="mt-6" />

      <EmptyPanel
        className="mt-4"
        title="Nothing here was executed by Arena"
        note="Every battle behind every number on this page ran on a contributor's own machine, with their own agent CLI and their own subscription, and was uploaded afterwards. The verified pool, which would be Arena-executed, is deliberately empty."
      />
    </Container>
  );
}
