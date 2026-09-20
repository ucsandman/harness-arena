import type { Metadata } from 'next';
import Link from 'next/link';
import {
  RATING_CATEGORIES,
  RATING_CATEGORY_LABELS,
  RATING_MIN_SAMPLE,
  RATING_POOL_LABELS,
  VERIFIED_REQUIREMENTS,
  ratingCategorySchema,
  ratingPoolSchema,
  type RatingCategory,
  type RatingPool,
} from '@harness-arena/protocol';
import { getLeaderboard, type LeaderboardRow } from '@harness-arena/database';
import {
  FormGlyphs,
  GlickoFootnote,
  RatingValue,
  SampleBadge,
  withRanks,
} from '@/components/ratings/RatingBits';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { cn } from '@/lib/cn';
import { formatUtcDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Leaderboard',
  description:
    'Glicko-1 ratings per harness, agent and category from decided battles. Community (self-reported local battles) and verified (Arena-executed) pools never mix.',
  alternates: { canonical: '/leaderboard' },
};

interface PageProps {
  searchParams: Promise<{ category?: string; pool?: string; agent?: string }>;
}

interface View {
  category: RatingCategory;
  pool: RatingPool;
  agent: string | null;
}

function href(view: View): string {
  const query = new URLSearchParams({ category: view.category, pool: view.pool });
  if (view.agent) query.set('agent', view.agent);
  return `/leaderboard?${query.toString()}`;
}

type Ranked = LeaderboardRow & { rank: number | null };

function Rows({ rows }: { rows: Ranked[] }) {
  return (
    <>
      {rows.map((row) => (
        <TR key={`${row.harnessId}-${row.agentId}`}>
          <TD mono className="text-right">
            {row.rank ?? '—'}
          </TD>
          <TD>
            <Link href={`/harnesses/${row.harnessSlug}`} className="font-medium hover:text-accent">
              {row.harnessName}
            </Link>
          </TD>
          <TD mono>{row.agentId}</TD>
          <TD mono className="text-right">
            <RatingValue rating={row.rating} deviation={row.deviation} />
          </TD>
          <TD mono className="text-right text-fg-muted">
            {Math.round(row.peakRating)}
          </TD>
          <TD mono className="text-right">
            {row.battles}
          </TD>
          <TD mono className="text-right">
            {row.wins} / {row.losses} / {row.ties}
          </TD>
          <TD>
            <FormGlyphs form={row.form} />
          </TD>
          <TD mono className="text-fg-muted">
            {row.lastBattleAt ? formatUtcDate(row.lastBattleAt.toISOString()) : '—'}
          </TD>
          <TD>
            <SampleBadge provisional={row.provisional} battles={row.battles} />
          </TD>
        </TR>
      ))}
    </>
  );
}

/** What the verified pool would require, listed in full so "empty" reads as a standard, not a gap. */
function VerifiedCard({ view, populated }: { view: View; populated: boolean }) {
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{populated ? 'Verified pool, not Arena-executed' : 'No verified battles exist'}</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3 text-[0.8125rem] text-fg-muted">
        <p>
          A verified battle is one Arena executed itself, in identical sandboxes, with no access to the
          competitors&apos; machines. The data model, the pool separation and the API accept them today;{' '}
          {populated
            ? 'no cloud runner is hosted, so nothing rated in this pool was executed by Arena.'
            : 'no hosted runner exists; this pool is empty.'}
        </p>
        <div>
          <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            What verified would guarantee
          </h3>
          <ul className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {VERIFIED_REQUIREMENTS.map((requirement) => (
              <li key={requirement.key} className="flex gap-2 text-xs leading-relaxed">
                <span className="font-mono text-2xs text-fg-subtle">{requirement.key}</span>
                <span>{requirement.label}</span>
              </li>
            ))}
          </ul>
        </div>
        <p>
          Nothing in this repository can spend model credits on Arena&apos;s behalf. Until that changes, the
          honest leaderboard is the{' '}
          <Link href={href({ ...view, pool: 'community' })} className="text-accent hover:underline">
            community pool
          </Link>
          : self-reported local battles.
        </p>
      </CardBody>
    </Card>
  );
}

export default async function LeaderboardPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const category: RatingCategory = ratingCategorySchema.safeParse(query.category).data ?? 'overall';
  const pool: RatingPool = ratingPoolSchema.safeParse(query.pool).data ?? 'community';
  const requestedAgent = query.agent?.trim() ?? '';

  const dbh = await db();
  const all = withRanks(await getLeaderboard(dbh, { category, pool, limit: 200 }));
  const agents = [...new Set(all.map((row) => row.agentId))].sort();
  // an agent that has no row in this category is not offered as a filter, and is ignored if asked for
  const agent = requestedAgent && agents.includes(requestedAgent) ? requestedAgent : null;
  const view: View = { category, pool, agent };
  const rows = agent ? all.filter((row) => row.agentId === agent) : all;

  // The card below speaks for the whole verified pool, while `rows` is scoped to one category, so an
  // empty category would otherwise render a false global claim. Every rated battle writes an `overall`
  // row, so one row there decides whether the pool is empty.
  const verifiedRows =
    pool === 'verified' ? await getLeaderboard(dbh, { category: 'overall', pool: 'verified', limit: 1 }) : [];
  const ranked = rows.filter((row) => !row.provisional);
  const provisional = rows.filter((row) => row.provisional);

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="leaderboard"
        title="Leaderboard"
        description="Glicko-1 per (harness, agent, category) from battles with a decided winner. A rating is a foundation, not a claim: below the minimum sample it is listed as provisional and never ranked."
      />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Pool</span>
        {ratingPoolSchema.options.map((option) => (
          <Link
            key={option}
            href={href({ ...view, pool: option })}
            aria-current={option === pool ? 'true' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-2xs font-medium',
              option === pool
                ? 'border-accent-border bg-accent-subtle text-accent'
                : 'border-border text-fg-muted hover:bg-bg-subtle hover:text-fg',
            )}
          >
            {RATING_POOL_LABELS[option]}
          </Link>
        ))}
        <span className="text-2xs text-fg-subtle">
          {pool === 'community'
            ? 'Self-reported local battles. Never mixed with verified.'
            : 'Arena-executed battles only. Never mixed with community.'}
        </span>
      </div>

      {pool === 'verified' ? <VerifiedCard view={view} populated={verifiedRows.length > 0} /> : null}

      <nav aria-label="Rating categories" className="mt-6 flex flex-wrap gap-1 border-b border-border">
        {RATING_CATEGORIES.map((item) => (
          <Link
            key={item}
            href={href({ ...view, category: item })}
            aria-current={item === category ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[0.8125rem] font-medium transition-colors',
              item === category
                ? 'border-accent text-fg'
                : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
            )}
          >
            {RATING_CATEGORY_LABELS[item]}
          </Link>
        ))}
      </nav>

      {agents.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Agent</span>
          <Link
            href={href({ ...view, agent: null })}
            aria-current={agent === null ? 'true' : undefined}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-2xs font-medium',
              agent === null
                ? 'border-accent-border bg-accent-subtle text-accent'
                : 'border-border text-fg-muted hover:bg-bg-subtle hover:text-fg',
            )}
          >
            all agents
          </Link>
          {agents.map((option) => (
            <Link
              key={option}
              href={href({ ...view, agent: option })}
              aria-current={option === agent ? 'true' : undefined}
              className={cn(
                'rounded-full border px-2.5 py-0.5 font-mono text-2xs font-medium',
                option === agent
                  ? 'border-accent-border bg-accent-subtle text-accent'
                  : 'border-border text-fg-muted hover:bg-bg-subtle hover:text-fg',
              )}
            >
              {option}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mt-4">
        {rows.length === 0 ? (
          <div className="rounded-card border border-border bg-surface px-4 py-5">
            <h2 className="text-sm font-semibold">
              Nothing rated in {RATING_CATEGORY_LABELS[category]} yet
              {agent ? ` for ${agent}` : ''}
            </h2>
            <p className="mt-1 max-w-2xl text-[0.8125rem] text-fg-muted">
              Ratings move only on a public battle with a decided winner. Demo battles, undecided verdicts and
              battles that failed an integrity check never count.
            </p>
          </div>
        ) : (
          <TableWrap>
            <Table
              caption={`${RATING_CATEGORY_LABELS[category]} ratings, ${pool} pool${agent ? `, ${agent}` : ''}`}
            >
              <THead>
                <TR>
                  <TH className="text-right">#</TH>
                  <TH>Harness</TH>
                  <TH>Agent</TH>
                  <TH className="text-right">Rating</TH>
                  <TH className="text-right">Peak</TH>
                  <TH className="text-right">Battles</TH>
                  <TH className="text-right">W / L / T</TH>
                  <TH>Form</TH>
                  <TH>Last battle</TH>
                  <TH>Sample</TH>
                </TR>
              </THead>
              <TBody>
                <Rows rows={ranked} />
                {provisional.length > 0 ? (
                  <TR>
                    <TD
                      colSpan={10}
                      className="bg-bg-subtle text-2xs font-semibold uppercase tracking-wider text-fg-subtle"
                    >
                      Provisional — fewer than {RATING_MIN_SAMPLE} decided battles, not ranked
                    </TD>
                  </TR>
                ) : null}
                <Rows rows={provisional} />
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>

      <Card className="mt-6">
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Think your harness is better? Prove it.</h2>
            <p className="mt-1 max-w-2xl text-[0.8125rem] text-fg-muted">
              Open a challenge against any harness on this table. You or whoever accepts runs it locally with
              the <span className="font-mono">{BRAND.cli.bin}</span> CLI and uploads the battle; Arena hosts
              no runner, so every result here is community-reported.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button href="/challenges/new" size="sm">
              Open a challenge
            </Button>
            <Button href="/docs/ratings" size="sm" variant="secondary">
              How ratings work
            </Button>
          </div>
        </CardBody>
      </Card>

      <GlickoFootnote className="mt-4" />
    </Container>
  );
}
