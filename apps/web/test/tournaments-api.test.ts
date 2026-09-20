import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Tournament } from '@harness-arena/protocol';
import { POST as createTournament } from '@/app/api/v1/tournaments/route';
import { GET as readTournament } from '@/app/api/v1/tournaments/[id]/route';
import { POST as startTournament } from '@/app/api/v1/tournaments/[id]/start/route';
import { resetRateLimits } from '@/lib/api';
import { getRequest, jsonRequest, makeDevice, params } from './helpers';

function tournamentRequest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test Bracket',
    agent: { id: 'fake' },
    target: {
      kind: 'task',
      task: { kind: 'prompt', prompt: 'fix the bug' },
      repository: { source: 'empty' },
    },
    entrants: [
      { label: 'Harness A', harness: { source: 'https://github.com/owner/harness-a' } },
      { label: 'Harness B', harness: { source: 'https://github.com/owner/harness-b' } },
      { label: 'Harness C', harness: { source: 'https://github.com/owner/harness-c' } },
      { label: 'Harness D', harness: { source: 'https://github.com/owner/harness-d' } },
    ],
    ...overrides,
  };
}

describe('tournaments API', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('creates a 4-entrant bracket, reads it by id and by slug, and starts it', async () => {
    const creator = await makeDevice('tournament-creator', 9711);
    const stranger = await makeDevice('tournament-stranger', 9712);

    const created = await createTournament(
      jsonRequest('/api/v1/tournaments', tournamentRequest(), { token: creator.token }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const tournament: Tournament = createdBody.tournament;
    expect(tournament.status).toBe('draft');
    expect(createdBody.url).toBe(`http://localhost:3000/tournaments/${tournament.slug}`);
    expect(createdBody.note.length).toBeGreaterThan(0);

    expect(tournament.entrants).toHaveLength(4);
    expect(tournament.entrants.map((entrant) => entrant.seed).sort()).toEqual([1, 2, 3, 4]);
    expect(tournament.rounds).toHaveLength(2);

    const byId = await readTournament(
      getRequest(`/api/v1/tournaments/${tournament.id}`),
      params({ id: tournament.id }),
    );
    expect(byId.status).toBe(200);
    expect((await byId.json()).tournament.id).toBe(tournament.id);

    const bySlug = await readTournament(
      getRequest(`/api/v1/tournaments/${tournament.slug}`),
      params({ id: tournament.slug }),
    );
    expect(bySlug.status).toBe(200);
    expect((await bySlug.json()).tournament.id).toBe(tournament.id);

    const strangerStart = await startTournament(
      jsonRequest(`/api/v1/tournaments/${tournament.id}/start`, {}, { token: stranger.token }),
      params({ id: tournament.id }),
    );
    expect(strangerStart.status).toBe(403);

    const start = await startTournament(
      jsonRequest(`/api/v1/tournaments/${tournament.id}/start`, {}, { token: creator.token }),
      params({ id: tournament.id }),
    );
    expect(start.status).toBe(200);
    expect((await start.json()).tournament.status).toBe('running');
  });
});
