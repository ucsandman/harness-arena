import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Tournament, TournamentEntrant, TournamentMatch } from '@harness-arena/protocol';
import { getTournament, pendingMatches } from '@harness-arena/database';
import {
  EmptyPanel,
  ExecutionNote,
  TOURNAMENT_STATUS_VARIANT,
  TargetSummary,
} from '@/components/arena/shared';
import { startTournamentAction } from '@/app/tournaments/actions';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
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

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const dbh = await db();
  const tournament = await getTournament(dbh, id);
  if (!tournament) return { title: 'Tournament', robots: { index: false, follow: false } };
  return {
    title: tournament.name,
    description:
      tournament.description ??
      `A single-elimination bracket over ${tournament.entrants.length} harnesses on ${tournament.agent.id}. Every match is run locally by a contributor.`,
    alternates: { canonical: `/tournaments/${tournament.slug}` },
    ...(tournament.visibility === 'public' ? {} : { robots: { index: false, follow: false } }),
  };
}

function roundName(index: number, total: number): string {
  const fromEnd = total - index;
  if (fromEnd === 1) return 'Final';
  if (fromEnd === 2) return 'Semifinals';
  if (fromEnd === 3) return 'Quarterfinals';
  return `Round ${index + 1}`;
}

const SETTLED_LABEL: Record<NonNullable<TournamentMatch['settledBy']>, string> = {
  bye: 'bye',
  seed: 'seed (tie)',
  verdict: 'verdict',
  forfeit: 'forfeit',
};

function entrantAt(entrants: readonly TournamentEntrant[], index: number | null): TournamentEntrant | null {
  if (index === null) return null;
  return entrants.find((entrant) => entrant.index === index) ?? null;
}

function Slot({
  entrant,
  isWinner,
  decided,
}: {
  entrant: TournamentEntrant | null;
  isWinner: boolean;
  decided: boolean;
}) {
  if (!entrant) {
    return (
      <span className="flex items-center justify-between gap-2 px-2 py-1 text-2xs text-fg-subtle">
        waiting on the previous round
      </span>
    );
  }
  return (
    <span
      className={cn(
        'flex items-center justify-between gap-2 px-2 py-1',
        isWinner && 'bg-accent-subtle',
        decided && !isWinner && 'opacity-60',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="font-mono text-2xs text-fg-subtle">
          {entrant.seed === null ? '—' : `#${entrant.seed}`}
        </span>
        <span className={cn('truncate text-2xs', isWinner ? 'font-semibold text-accent' : 'text-fg')}>
          {entrant.label}
        </span>
      </span>
      {entrant.harnessSlug ? (
        <Link
          href={`/harnesses/${entrant.harnessSlug}`}
          className="shrink-0 font-mono text-2xs text-fg-subtle hover:text-accent"
        >
          {entrant.harnessSlug}
        </Link>
      ) : null}
    </span>
  );
}

function MatchCard({ match, entrants }: { match: TournamentMatch; entrants: readonly TournamentEntrant[] }) {
  const a = entrantAt(entrants, match.a);
  const b = entrantAt(entrants, match.b);
  const decided = match.winner !== null;
  return (
    <li className="w-56 rounded-card border border-border bg-surface">
      <div className="divide-y divide-border">
        <Slot entrant={a} isWinner={decided && match.winner === match.a} decided={decided} />
        {match.bye ? (
          <span className="flex items-center gap-2 px-2 py-1 text-2xs text-fg-subtle">no opponent: bye</span>
        ) : (
          <Slot entrant={b} isWinner={decided && match.winner === match.b} decided={decided} />
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1">
        <span className="font-mono text-2xs text-fg-subtle">
          {match.settledBy ? SETTLED_LABEL[match.settledBy] : 'pending'}
        </span>
        {match.battleIds.length > 0 ? (
          <Link
            href={`/battles/${match.battleIds[0]}`}
            className="font-mono text-2xs text-accent hover:underline"
          >
            battle
          </Link>
        ) : (
          <span className="font-mono text-2xs text-fg-subtle">no battle</span>
        )}
      </div>
    </li>
  );
}

function Bracket({ tournament }: { tournament: Tournament }) {
  const total = tournament.rounds.length;
  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-max gap-6 pb-2">
        {tournament.rounds.map((round) => (
          <section key={round.index} className="flex flex-col gap-2">
            <h3 className="font-mono text-2xs font-medium uppercase tracking-[0.14em] text-accent">
              {roundName(round.index, total)}
            </h3>
            <ul className="flex h-full flex-col justify-around gap-3">
              {round.matches.map((match) => (
                <MatchCard key={match.id} match={match} entrants={tournament.entrants} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export default async function TournamentDetailPage({ params }: PageProps) {
  const { id } = await params;
  const dbh = await db();
  const user = await getCurrentUser();
  const tournament = await getTournament(dbh, id);
  if (!tournament) notFound();

  const pending = await pendingMatches(dbh, tournament.id);
  const champion = entrantAt(tournament.entrants, tournament.winner);
  const isCreator = user !== null && tournament.createdBy?.id === user.id;

  return (
    <Container size="wide" className="py-10">
      <SectionHeading
        eyebrow="harness arena championship"
        title={tournament.name}
        description={tournament.description ?? undefined}
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge variant={TOURNAMENT_STATUS_VARIANT[tournament.status]}>{tournament.status}</Badge>
        <Badge variant="outline" mono>
          {tournament.slug}
        </Badge>
        <Badge variant="neutral" mono>
          agent {tournament.agent.id}
        </Badge>
        <Badge variant="neutral" mono>
          {tournament.entrants.length} entrants
        </Badge>
        <Badge variant="neutral" mono>
          {tournament.format.replace('_', ' ')}
        </Badge>
        <span className="text-2xs text-fg-subtle">
          by {tournament.createdBy?.login ?? 'an account that has since been removed'} ·{' '}
          {formatUtcDate(tournament.createdAt)}
          {tournament.startedAt ? ` · started ${formatUtcDate(tournament.startedAt)}` : ''}
        </span>
      </div>

      {champion ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>&#9733; Champion</CardTitle>
            <span className="text-2xs text-fg-subtle">
              settled {tournament.completedAt ? formatUtcDate(tournament.completedAt) : 'recently'}
            </span>
          </CardHeader>
          <CardBody className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-lg font-semibold">{champion.label}</span>
            <span className="font-mono text-2xs text-fg-subtle">
              seed {champion.seed ?? '—'} · {champion.harness.source}
            </span>
            {champion.harnessSlug ? (
              <Link
                href={`/harnesses/${champion.harnessSlug}`}
                className="font-mono text-2xs text-accent hover:underline"
              >
                /harnesses/{champion.harnessSlug}
              </Link>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <ExecutionNote className="mt-6" />

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Target</CardTitle>
        </CardHeader>
        <CardBody>
          <TargetSummary target={tournament.target} />
        </CardBody>
      </Card>

      <h2 className="mt-8 text-sm font-semibold">Bracket</h2>
      <p className="mt-1 max-w-3xl text-2xs text-fg-subtle">
        Seeded by community overall rating for {tournament.agent.id} at the moment the bracket was built; an
        unrated harness starts at 1500 and equal ratings keep the creator&apos;s order. Top seeds take byes
        when the entrant count is not a power of two, and a bye is settled the moment the bracket exists.
      </p>
      <div className="mt-3">
        <Bracket tournament={tournament} />
      </div>

      <h2 className="mt-8 text-sm font-semibold">Pending matches</h2>
      <div className="mt-3">
        {pending.length === 0 ? (
          <EmptyPanel
            title={
              tournament.status === 'completed' ? 'Nothing left to run' : 'No match has both slots filled yet'
            }
            note={
              tournament.status === 'completed'
                ? 'Every match has settled and the final named a champion.'
                : 'A match becomes runnable when both of its slots are filled by the rounds feeding it.'
            }
          />
        ) : (
          <>
            <TableWrap>
              <Table caption="Matches waiting to be run">
                <THead>
                  <TR>
                    <TH>Round</TH>
                    <TH>Match</TH>
                    <TH>Side A</TH>
                    <TH>Side B</TH>
                    <TH>Id</TH>
                  </TR>
                </THead>
                <TBody>
                  {pending.map((match) => (
                    <TR key={match.id}>
                      <TD>{roundName(match.round, tournament.rounds.length)}</TD>
                      <TD mono className="text-right">
                        {match.position + 1}
                      </TD>
                      <TD className="text-2xs">{entrantAt(tournament.entrants, match.a)?.label ?? '—'}</TD>
                      <TD className="text-2xs">{entrantAt(tournament.entrants, match.b)?.label ?? '—'}</TD>
                      <TD mono className="text-2xs">
                        {match.id}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
            <div className="mt-3">
              <CodeBlock
                terminal
                code={`${BRAND.cli.bin} login\n${BRAND.cli.bin} tournament play ${tournament.id}`}
              />
              <p className="mt-2 text-2xs text-fg-subtle">
                That runs every match whose two slots are filled and which has no winner yet, on your machine,
                uploads each one, re-fetches the bracket and repeats. Any number of people can do this at
                once; a match is settled once, by the first verified battle.
              </p>
            </div>
          </>
        )}
      </div>

      {isCreator && tournament.status === 'draft' ? (
        <form action={startTournamentAction} className="mt-6 flex flex-wrap items-center gap-3">
          <input type="hidden" name="tournamentId" value={tournament.id} />
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Open this tournament for play
          </button>
          <span className="text-2xs text-fg-subtle">
            Only you can. It changes the status to running; anybody can then play a pending match.
          </span>
        </form>
      ) : null}

      <p className="mt-6 text-2xs text-fg-subtle">
        A tournament match is slot-exact: the entrant in slot A must have run as side A, or the battle is
        refused rather than reinterpreted.{' '}
        <Link href="/docs/challenges" className="text-accent hover:underline">
          How a match settles
        </Link>
        .
      </p>
    </Container>
  );
}
