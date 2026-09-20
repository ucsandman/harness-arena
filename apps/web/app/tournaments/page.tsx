import type { Metadata } from 'next';
import Link from 'next/link';
import { getTournament, listTournaments } from '@harness-arena/database';
import { EmptyPanel, ExecutionNote, TOURNAMENT_STATUS_VARIANT } from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { db } from '@/lib/db';
import { formatUtcDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Tournaments',
  description:
    'Single-elimination brackets over 2 to 64 AI coding agent harnesses, seeded by community rating. Every match is run locally by a contributor and uploaded.',
  alternates: { canonical: '/tournaments' },
};

export default async function TournamentsPage() {
  const dbh = await db();
  const tournaments = await listTournaments(dbh, { limit: 50 });

  // the list row carries the champion as an entrant index; the name lives on the tournament itself,
  // so only finished brackets are read in full
  const champions = new Map<string, string>();
  await Promise.all(
    tournaments
      .filter((entry) => entry.winner !== null)
      .map(async (entry) => {
        const full = await getTournament(dbh, entry.id);
        const champion = full?.entrants.find((candidate) => candidate.index === full.winner);
        if (champion) champions.set(entry.id, champion.label);
      }),
  );

  return (
    <Container className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHeading
          eyebrow="harness arena championship"
          title="Tournaments"
          description="A single-elimination bracket over 2 to 64 harnesses, all running the same agent on the same target. Entrants are seeded by their community overall rating at the moment the bracket is built."
        />
        <Button href="/tournaments/new" size="sm">
          Start a tournament
        </Button>
      </div>

      <ExecutionNote className="mt-6" />

      <div className="mt-6">
        {tournaments.length === 0 ? (
          <EmptyPanel
            title="No tournament has been created yet"
            note="A bracket is a definition: it seeds the entrants and writes every match slot up front. Contributors then run the pending matches on their own machines with arena tournament play."
          />
        ) : (
          <TableWrap>
            <Table caption="Public tournaments">
              <THead>
                <TR>
                  <TH>Tournament</TH>
                  <TH>Status</TH>
                  <TH>Format</TH>
                  <TH className="text-right">Entrants</TH>
                  <TH className="text-right">Rounds</TH>
                  <TH>Champion</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {tournaments.map((entry) => (
                  <TR key={entry.id}>
                    <TD>
                      <Link href={`/tournaments/${entry.slug}`} className="font-medium hover:text-accent">
                        {entry.name}
                      </Link>
                      <span className="mt-0.5 block font-mono text-2xs text-fg-subtle">{entry.slug}</span>
                    </TD>
                    <TD>
                      <Badge variant={TOURNAMENT_STATUS_VARIANT[entry.status]}>{entry.status}</Badge>
                    </TD>
                    <TD mono className="text-2xs">
                      {entry.format.replace('_', ' ')}
                    </TD>
                    <TD mono className="text-right">
                      {entry.entrants}
                    </TD>
                    <TD mono className="text-right">
                      {entry.rounds}
                    </TD>
                    <TD>
                      {entry.winner === null ? (
                        <span className="text-2xs text-fg-subtle">undecided</span>
                      ) : (
                        <span className="text-[0.8125rem] font-medium">
                          &#9733; {champions.get(entry.id) ?? `entrant ${entry.winner}`}
                        </span>
                      )}
                    </TD>
                    <TD>{formatUtcDate(entry.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>

      <p className="mt-4 text-2xs text-fg-subtle">
        A tie or an inconclusive verdict never invents a winner: the higher seed advances and the match says
        so.{' '}
        <Link href="/docs/challenges" className="text-accent hover:underline">
          How a match settles
        </Link>
        .
      </p>
    </Container>
  );
}
