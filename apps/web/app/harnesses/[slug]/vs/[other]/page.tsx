import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  RATING_CATEGORIES,
  RATING_CATEGORY_LABELS,
  RATING_POOL_LABELS,
  ratingCategorySchema,
  ratingPoolSchema,
  type HeadToHeadFilter,
  type RatingCategory,
  type RatingPool,
} from '@harness-arena/protocol';
import {
  getBattle,
  getHarnessBySlug,
  getHarnessProfile,
  getHeadToHead,
  listBenchmarks,
} from '@harness-arena/database';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Stat } from '@/components/ui/Stat';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { cn } from '@/lib/cn';
import { formatPercent, formatUtcDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string; other: string }>;
  searchParams: Promise<{
    agent?: string;
    category?: string;
    pool?: string;
    benchmark?: string;
    since?: string;
  }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, other } = await params;
  return {
    title: `${slug} vs ${other}`,
    description: `Every public battle between ${slug} and ${other}, with the filters that produced each number.`,
    alternates: { canonical: `/harnesses/${slug}/vs/${other}` },
  };
}

/** Presets for the date filter. `null` days means no lower bound. */
const SINCE_PRESETS: Array<{ label: string; days: number | null }> = [
  { label: 'all time', days: null },
  { label: 'last 30 days', days: 30 },
  { label: 'last 90 days', days: 90 },
  { label: 'last year', days: 365 },
];

function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

type Query = { agent?: string; category?: string; pool?: string; benchmark?: string; since?: string };

function href(slug: string, other: string, query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const suffix = params.toString();
  return `/harnesses/${slug}/vs/${other}${suffix ? `?${suffix}` : ''}`;
}

function FilterChip({
  href: target,
  active,
  children,
  mono,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <Link
      href={target}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-2xs font-medium',
        mono && 'font-mono',
        active
          ? 'border-accent-border bg-accent-subtle text-accent'
          : 'border-border text-fg-muted hover:bg-bg-subtle hover:text-fg',
      )}
    >
      {children}
    </Link>
  );
}

export default async function HeadToHeadPage({ params, searchParams }: PageProps) {
  const { slug, other } = await params;
  const query = await searchParams;
  const dbh = await db();

  const category: RatingCategory | undefined = ratingCategorySchema.safeParse(query.category).data;
  const pool: RatingPool | undefined = ratingPoolSchema.safeParse(query.pool).data;
  const agent = query.agent?.trim() || undefined;
  const benchmark = query.benchmark?.trim() || undefined;
  const since = query.since?.trim() || undefined;

  const filter: HeadToHeadFilter = {
    ...(agent ? { agentId: agent } : {}),
    ...(category ? { category } : {}),
    ...(pool ? { pool } : {}),
    ...(benchmark ? { benchmarkSlug: benchmark } : {}),
    ...(since ? { since } : {}),
  };

  const record = await getHeadToHead(dbh, slug, other, filter);
  if (!record) notFound();

  const [subjectHarness, opponentHarness, subjectProfile, benchmarks, battleRows] = await Promise.all([
    getHarnessBySlug(dbh, slug),
    getHarnessBySlug(dbh, other),
    getHarnessProfile(dbh, slug),
    listBenchmarks(dbh, { limit: 20 }),
    Promise.all(record.recentBattleIds.map((id) => getBattle(dbh, id))),
  ]);

  const agents = [...new Set((subjectProfile?.ratings ?? []).map((rating) => rating.agentId))].sort();
  const current: Query = { agent, category, pool, benchmark, since };
  const battles = battleRows.flatMap((found) => (found ? [found.battle] : []));

  // `--a`/`--b` take what the CLI can resolve: a URL or a local path, never a catalogue slug. Showing
  // the slug here would hand over a command that fails on the first run.
  const sideRef = (harness: { sourceUrl: string | null; slug: string } | null, fallback: string): string =>
    harness?.sourceUrl ?? (harness?.slug === 'vanilla' ? 'vanilla' : fallback);
  const command = [
    `${BRAND.cli.bin} challenge create`,
    `--a ${sideRef(subjectHarness, slug)}`,
    `--b ${sideRef(opponentHarness, other)}`,
    `--agent ${agent ?? agents[0] ?? 'claude-code'}`,
    '--task ./task.md',
    '--repo https://github.com/owner/repo',
  ].join(' ');

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="head-to-head"
        title={
          <>
            <Link href={`/harnesses/${slug}`} className="hover:text-accent">
              {record.subject.name}
            </Link>{' '}
            <span className="text-fg-subtle">vs</span>{' '}
            <Link href={`/harnesses/${other}`} className="hover:text-accent">
              {record.opponent.name}
            </Link>
          </>
        }
        description="Nothing here is modelled or predicted. The filters below narrow the set of real public battles, and every number on this page is counted from exactly that set."
      />

      <Card className="mt-6">
        <CardBody className="flex flex-wrap items-end gap-8">
          <Stat
            label="Record"
            value={`${record.wins} / ${record.losses} / ${record.ties}`}
            hint={`W / L / T for ${record.subject.name}`}
          />
          <Stat
            label="Win rate"
            value={record.winRate === null ? 'n/a' : formatPercent(record.winRate)}
            hint={record.battles === 0 ? 'no decided battles' : `of ${record.battles} decided`}
          />
          <Stat label="Decided battles" value={record.battles} hint="a winner or an explicit tie" />
          <Stat
            label="Inconclusive"
            value={record.inconclusive}
            hint="counted, never dropped"
          />
          <Stat
            label="Last battle"
            value={record.lastBattleAt ? formatUtcDate(record.lastBattleAt) : '—'}
            hint="UTC"
          />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <Link
            href={href(slug, other, {})}
            className="text-2xs text-accent hover:underline"
            aria-label="Clear every filter"
          >
            clear all
          </Link>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {agents.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-2xs font-medium uppercase tracking-wide text-fg-muted">
                Agent
              </span>
              <FilterChip href={href(slug, other, { ...current, agent: undefined })} active={!agent}>
                any
              </FilterChip>
              {agents.map((option) => (
                <FilterChip
                  key={option}
                  mono
                  href={href(slug, other, { ...current, agent: option })}
                  active={agent === option}
                >
                  {option}
                </FilterChip>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-2xs font-medium uppercase tracking-wide text-fg-muted">
              Category
            </span>
            <FilterChip href={href(slug, other, { ...current, category: undefined })} active={!category}>
              any
            </FilterChip>
            {RATING_CATEGORIES.map((option) => (
              <FilterChip
                key={option}
                href={href(slug, other, { ...current, category: option })}
                active={category === option}
              >
                {RATING_CATEGORY_LABELS[option]}
              </FilterChip>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-2xs font-medium uppercase tracking-wide text-fg-muted">
              Pool
            </span>
            <FilterChip href={href(slug, other, { ...current, pool: undefined })} active={!pool}>
              any
            </FilterChip>
            {ratingPoolSchema.options.map((option) => (
              <FilterChip
                key={option}
                href={href(slug, other, { ...current, pool: option })}
                active={pool === option}
              >
                {RATING_POOL_LABELS[option]}
              </FilterChip>
            ))}
          </div>

          {benchmarks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-2xs font-medium uppercase tracking-wide text-fg-muted">
                Benchmark
              </span>
              <FilterChip href={href(slug, other, { ...current, benchmark: undefined })} active={!benchmark}>
                any
              </FilterChip>
              {benchmarks.map((pack) => (
                <FilterChip
                  key={pack.slug}
                  mono
                  href={href(slug, other, { ...current, benchmark: pack.slug })}
                  active={benchmark === pack.slug}
                >
                  {pack.slug}
                </FilterChip>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-2xs font-medium uppercase tracking-wide text-fg-muted">
              Since
            </span>
            {SINCE_PRESETS.map((preset) => {
              const value = preset.days === null ? undefined : isoDaysAgo(preset.days);
              return (
                <FilterChip
                  key={preset.label}
                  href={href(slug, other, { ...current, since: value })}
                  active={preset.days === null ? !since : since === value}
                >
                  {preset.label}
                </FilterChip>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Battles behind these numbers</CardTitle>
          <span className="text-2xs text-fg-subtle">
            {battles.length === 0
              ? 'none under the current filters'
              : `newest ${battles.length} of ${record.battles + record.inconclusive}`}
          </span>
        </CardHeader>
        <div className="border-t border-border">
          {battles.length === 0 ? (
            <p className="px-4 py-3 text-[0.8125rem] text-fg-muted">
              These two harnesses have not met under the current filters. Widen them, or open a challenge
              below.
            </p>
          ) : (
            <TableWrap>
              <Table caption="Battles between these two harnesses">
                <THead>
                  <TR>
                    <TH>Battle</TH>
                    <TH>Winner</TH>
                    <TH>Category</TH>
                    <TH>Date</TH>
                  </TR>
                </THead>
                <TBody>
                  {battles.map((battle) => (
                    <TR key={battle.id}>
                      <TD>
                        <Link href={`/battles/${battle.id}`} className="font-medium hover:text-accent">
                          {battle.title}
                        </Link>
                        <span className="ml-2 font-mono text-2xs text-fg-subtle">
                          {battle.id.slice(0, 14)}
                        </span>
                      </TD>
                      <TD>
                        {battle.winner === null ? (
                          <Badge variant="neutral">undecided</Badge>
                        ) : battle.winner === 'tie' ? (
                          <Badge variant="neutral">tie</Badge>
                        ) : (
                          <Badge variant={battle.winner === 'a' ? 'side-a' : 'side-b'}>
                            side {battle.winner}
                          </Badge>
                        )}
                      </TD>
                      <TD mono className="text-fg-muted">
                        {battle.category ?? '—'}
                      </TD>
                      <TD mono className="text-fg-muted">
                        {formatUtcDate(battle.createdAt.toISOString())}
                      </TD>
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
          <CardTitle>Run this matchup</CardTitle>
          <span className="text-2xs text-fg-subtle">Arena hosts no runner; this runs on your machine.</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          <p className="text-[0.8125rem] text-fg-muted">
            Point <span className="font-mono">--task</span> at a task file and{' '}
            <span className="font-mono">--repo</span> at the repository both sides work in, then run the
            challenge yourself or wait for someone to accept it. The uploaded battle is labelled community
            and joins the counts above.
          </p>
          <CodeBlock terminal code={command} />
          <p className="text-2xs text-fg-subtle">
            Prefer a form?{' '}
            <Link
              href={`/challenges/new?a=${encodeURIComponent(slug)}&b=${encodeURIComponent(other)}`}
              className="text-accent hover:underline"
            >
              Open a challenge in the browser
            </Link>
            .
          </p>
        </CardBody>
      </Card>
    </Container>
  );
}
