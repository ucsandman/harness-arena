import type { Metadata } from 'next';
import Link from 'next/link';
import {
  RATING_CATEGORIES,
  RATING_CATEGORY_LABELS,
  RATING_MIN_SAMPLE,
  ratingCategorySchema,
  ratingPoolSchema,
  type RatingCategory,
  type RatingPool,
} from '@harness-arena/protocol';
import { getLeaderboard, type LeaderboardRow } from '@harness-arena/database';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { db } from '@/lib/db';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Leaderboard',
  description:
    'Elo ratings per harness, agent and category from decided battles. Community (self-reported local battles) and verified (Arena-executed) pools never mix.',
  alternates: { canonical: '/leaderboard' },
};

interface PageProps {
  searchParams: Promise<{ category?: string; pool?: string }>;
}

function href(category: RatingCategory, pool: RatingPool): string {
  const query = new URLSearchParams({ category, pool });
  return `/leaderboard?${query.toString()}`;
}

function Rows({ rows, offset }: { rows: LeaderboardRow[]; offset: number }) {
  return (
    <>
      {rows.map((row, index) => (
        <TR key={`${row.harnessId}-${row.agentId}`}>
          <TD mono className="text-right">
            {row.provisional ? '—' : offset + index + 1}
          </TD>
          <TD>
            <Link href={`/harnesses/${row.harnessSlug}`} className="font-medium hover:text-accent">
              {row.harnessName}
            </Link>
          </TD>
          <TD mono>{row.agentId}</TD>
          <TD mono className="text-right">
            {Math.round(row.rating)}
            <span className="text-fg-subtle"> ±{Math.round(row.deviation)}</span>
          </TD>
          <TD mono className="text-right">
            {row.battles}
          </TD>
          <TD mono className="text-right">
            {row.wins} / {row.losses} / {row.ties}
          </TD>
          <TD>
            {row.provisional ? (
              <Badge variant="warn">provisional</Badge>
            ) : (
              <Badge variant="success">ranked</Badge>
            )}
          </TD>
        </TR>
      ))}
    </>
  );
}

export default async function LeaderboardPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const category: RatingCategory = ratingCategorySchema.safeParse(query.category).data ?? 'overall';
  const pool: RatingPool = ratingPoolSchema.safeParse(query.pool).data ?? 'community';

  const dbh = await db();
  const rows = await getLeaderboard(dbh, { category, pool, limit: 100 });
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
        description="Elo per (harness, agent, category) from battles with a decided winner. A rating is a foundation, not a claim: below the minimum sample it is listed as provisional and never ranked."
      />

      <nav aria-label="Rating categories" className="mt-6 flex flex-wrap gap-1 border-b border-border">
        {RATING_CATEGORIES.map((item) => (
          <Link
            key={item}
            href={href(item, pool)}
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

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Pool</span>
        {ratingPoolSchema.options.map((option) => (
          <Link
            key={option}
            href={href(category, option)}
            aria-current={option === pool ? 'true' : undefined}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-2xs font-medium',
              option === pool
                ? 'border-accent-border bg-accent-subtle text-accent'
                : 'border-border text-fg-muted hover:bg-bg-subtle hover:text-fg',
            )}
          >
            {option}
          </Link>
        ))}
      </div>

      {pool === 'verified' ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>
              {verifiedRows.length === 0 ? 'No verified battles exist' : 'Verified pool, not Arena-executed'}
            </CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2 text-[0.8125rem] text-fg-muted">
            <p>
              A verified battle is one Arena executed itself, in identical sandboxes, with no access to the
              competitors&apos; machines. The data model, the pool separation and the API accept them today;{' '}
              {verifiedRows.length === 0
                ? 'no cloud runner is hosted, so this pool is deliberately empty.'
                : 'no cloud runner is hosted, so nothing rated in this pool was executed by Arena.'}
            </p>
            <p>
              Nothing in this repository can spend model credits on Arena&apos;s behalf. Until that changes,
              the honest leaderboard is the{' '}
              <Link href={href(category, 'community')} className="text-accent hover:underline">
                community pool
              </Link>
              : self-reported local battles.
            </p>
          </CardBody>
        </Card>
      ) : null}

      <div className="mt-4">
        {rows.length === 0 ? (
          <div className="rounded-card border border-border bg-surface px-4 py-5">
            <h2 className="text-sm font-semibold">Nothing rated in {RATING_CATEGORY_LABELS[category]} yet</h2>
            <p className="mt-1 max-w-2xl text-[0.8125rem] text-fg-muted">
              Ratings move only on a public battle with a decided winner. Demo battles and undecided verdicts
              never count.
            </p>
          </div>
        ) : (
          <TableWrap>
            <Table caption={`${RATING_CATEGORY_LABELS[category]} ratings, ${pool} pool`}>
              <THead>
                <TR>
                  <TH className="text-right">#</TH>
                  <TH>Harness</TH>
                  <TH>Agent</TH>
                  <TH className="text-right">Rating</TH>
                  <TH className="text-right">Battles</TH>
                  <TH className="text-right">W / L / T</TH>
                  <TH>Sample</TH>
                </TR>
              </THead>
              <TBody>
                <Rows rows={ranked} offset={0} />
                {provisional.length > 0 ? (
                  <TR>
                    <TD
                      colSpan={7}
                      className="bg-bg-subtle text-2xs font-semibold uppercase tracking-wider text-fg-subtle"
                    >
                      Provisional — fewer than {RATING_MIN_SAMPLE} decided battles, not ranked
                    </TD>
                  </TR>
                ) : null}
                <Rows rows={provisional} offset={ranked.length} />
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>

      <p className="mt-4 text-2xs text-fg-subtle">
        Elo with K=32 on the battle verdict; the ± figure is a documented confidence term (max(50,
        350/sqrt(games+1))), not a Glicko deviation update.
      </p>
    </Container>
  );
}
