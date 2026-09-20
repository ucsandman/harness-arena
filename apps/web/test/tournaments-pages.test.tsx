import './setup-env';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTournamentRequestSchema } from '@harness-arena/protocol';
import { createTournament, pendingMatches } from '@harness-arena/database';
import TournamentsPage from '../app/tournaments/page';
import TournamentDetailPage from '../app/tournaments/[id]/page';
import { makeUser, testDb } from './helpers';

function tournamentRequest(entrantCount: number) {
  return createTournamentRequestSchema.parse({
    name: 'Harness cup',
    description: 'Five entrants, so the top seeds take byes.',
    agent: { id: 'fake' },
    target: {
      kind: 'task',
      title: 'Fix the parser',
      category: 'debugging',
      task: { kind: 'prompt', prompt: 'fix the bug' },
      repository: { source: 'empty' },
    },
    entrants: Array.from({ length: entrantCount }, (_, index) => ({
      label: `Entrant ${index + 1}`,
      harness: { source: index === 0 ? 'vanilla' : `https://github.com/owner/harness-${index}` },
    })),
  });
}

describe('/tournaments', () => {
  it('lists a draft bracket with its entrant and round counts and no invented champion', async () => {
    const dbh = await testDb();
    const user = await makeUser('tournament-author', 9831);
    const tournament = await createTournament(dbh, tournamentRequest(5), { createdByUserId: user.id });

    const html = renderToStaticMarkup(await TournamentsPage());
    expect(html).toContain(tournament.name);
    expect(html).toContain(tournament.slug);
    expect(html).toContain('draft');
    expect(html).toContain('undecided');
    expect(html).toContain('Arena hosts no runner');
  });
});

describe('/tournaments/[id]', () => {
  it('renders a 5-entrant bracket with three byes, named rounds, and the play command', async () => {
    const dbh = await testDb();
    const user = await makeUser('tournament-author-2', 9832);
    const tournament = await createTournament(dbh, tournamentRequest(5), { createdByUserId: user.id });

    expect(tournament.rounds).toHaveLength(3);
    const byes = tournament.rounds[0]?.matches.filter((match) => match.bye) ?? [];
    expect(byes).toHaveLength(3);
    for (const bye of byes) {
      expect(bye.settledBy).toBe('bye');
      expect(bye.winner).not.toBeNull();
    }

    const html = renderToStaticMarkup(
      await TournamentDetailPage({ params: Promise.resolve({ id: tournament.slug }) }),
    );

    // one card per bye, each saying so rather than showing an empty opponent slot
    expect(html.split('no opponent').length - 1).toBe(3);
    expect(html).toContain('Quarterfinals');
    expect(html).toContain('Semifinals');
    expect(html).toContain('Final');
    expect(html).toContain('bye');
    expect(html).toContain(`arena tournament play ${tournament.id}`);

    // a real match (seed 4 vs seed 5) plus the round-1 match both byes feed
    const pending = await pendingMatches(dbh, tournament.id);
    expect(pending).toHaveLength(2);
    for (const match of pending) expect(html).toContain(match.id);

    // nothing has been played, so no champion is claimed
    expect(html).not.toContain('Champion');
  });
});
