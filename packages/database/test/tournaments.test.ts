import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTournamentRequest } from '@harness-arena/protocol';
import { createTournamentRequestSchema } from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import { ratings } from '../src/schema/index.js';
import {
  bracketRounds,
  bracketSize,
  buildBracket,
  createTournament,
  getTournament,
  nextSlot,
  pendingMatches,
  settleMatch,
} from '../src/tournaments.js';
import { slugForSourceUrl } from '../src/arena-refs.js';
import { getHarnessBySlug, upsertBattleFromRecord } from '../src/queries.js';
import { buildRecord, freshDb } from './helpers.js';

describe('bracket maths', () => {
  it.each([2, 3, 4, 5, 8, 9])('builds a valid bracket for n=%i', (n) => {
    const bracket = buildBracket(n);
    const size = bracketSize(n);
    const round0 = bracket.filter((m) => m.round === 0);
    expect(round0).toHaveLength(size / 2);

    const rounds = new Set(bracket.map((m) => m.round));
    expect(rounds.size).toBe(bracketRounds(n));

    const seen: number[] = [];
    for (const match of round0) {
      expect(match.a).not.toBeNull();
      if (match.bye) {
        expect(match.b).toBeNull();
        expect(match.a as number).toBeLessThanOrEqual(n);
        seen.push(match.a as number);
      } else {
        expect(match.b).not.toBeNull();
        expect((match.a as number) + (match.b as number)).toBe(size + 1);
        seen.push(match.a as number, match.b as number);
      }
    }
    expect(seen.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));

    for (const match of bracket.filter((m) => m.round > 0)) {
      expect(match.a).toBeNull();
      expect(match.b).toBeNull();
      expect(match.bye).toBe(false);
    }
  });

  it('seeds 1 and 2 can only meet in the final for n=8', () => {
    const round0 = buildBracket(8).filter((m) => m.round === 0);
    expect(round0.map((m) => [m.a, m.b])).toEqual([
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6],
    ]);
  });

  it('nextSlot advances one round and alternates a/b by parity', () => {
    expect(nextSlot(0, 0)).toEqual({ round: 1, position: 0, slot: 'a' });
    expect(nextSlot(0, 1)).toEqual({ round: 1, position: 0, slot: 'b' });
    expect(nextSlot(0, 2)).toEqual({ round: 1, position: 1, slot: 'a' });
    expect(nextSlot(0, 3)).toEqual({ round: 1, position: 1, slot: 'b' });
    expect(nextSlot(1, 0)).toEqual({ round: 2, position: 0, slot: 'a' });
  });
});

describe('createTournament + settleMatch', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  const target: CreateTournamentRequest['target'] = {
    kind: 'task',
    task: { kind: 'prompt', prompt: 'Do the thing' },
    repository: { source: 'https://github.com/acme/widget' },
  };

  async function rateHarness(source: string, rating: number): Promise<void> {
    const record = buildRecord({ harnessA: { name: 'x', source, kind: 'github', commit: 'abc1234' } });
    await upsertBattleFromRecord(handle.db, { record });
    const row = await getHarnessBySlug(handle.db, slugForSourceUrl(source));
    if (!row) throw new Error('rateHarness: harness missing after upsert');
    await handle.db.insert(ratings).values({
      harnessId: row.id,
      agentId: 'claude-code',
      category: 'overall',
      pool: 'community',
      rating,
      deviation: 300,
    });
  }

  async function makeThreeEntrantTournament() {
    await rateHarness('https://github.com/acme/fast-harness', 1700);
    const req = createTournamentRequestSchema.parse({
      name: 'Test Cup',
      agent: { id: 'claude-code' },
      target,
      entrants: [
        { label: 'Fast', harness: { source: 'https://github.com/acme/fast-harness' } },
        { label: 'Beta', harness: { source: 'https://github.com/acme/beta-harness' } },
        { label: 'Gamma', harness: { source: 'https://github.com/acme/gamma-harness' } },
      ],
    });
    return createTournament(handle.db, req, { createdByUserId: null });
  }

  it('seeds by rating desc, ties by entrant order, and propagates the bye winner immediately', async () => {
    const tournament = await makeThreeEntrantTournament();
    expect(tournament.entrants.map((e) => e.seed)).toEqual([1, 2, 3]);

    const round1 = tournament.rounds[1]?.matches ?? [];
    expect(round1).toHaveLength(1);
    expect(round1[0]?.a).toBe(0);
    expect(round1[0]?.b).toBeNull();
  });

  it('pendingMatches returns only matches with both slots filled and no winner', async () => {
    const tournament = await makeThreeEntrantTournament();
    const pending = await pendingMatches(handle.db, tournament.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.a).toBe(1);
    expect(pending[0]?.b).toBe(2);
    expect(pending[0]?.winner).toBeNull();
  });

  it('settleMatch with a verdict winner advances the winner into the next round slot', async () => {
    const tournament = await makeThreeEntrantTournament();
    const round0 = tournament.rounds[0]?.matches ?? [];
    const match = round0.find((m) => !m.bye);
    if (!match) throw new Error('expected a non-bye round-0 match');

    const record = buildRecord({ winner: 'a' });
    const result = await settleMatch(handle.db, match.id, record);
    expect(result?.winner).toBe(match.a);
    expect(result?.settledBy).toBe('verdict');
    expect(result?.tournamentCompleted).toBe(false);

    const updated = await getTournament(handle.db, tournament.id);
    const round1 = updated?.rounds[1]?.matches ?? [];
    expect(round1[0]?.b).toBe(match.a);
  });

  it('settleMatch with a tie advances the higher seed and settles by seed', async () => {
    const req = createTournamentRequestSchema.parse({
      name: 'Two Cup',
      agent: { id: 'claude-code' },
      target,
      entrants: [
        { label: 'X', harness: { source: 'https://github.com/acme/x-harness' } },
        { label: 'Y', harness: { source: 'https://github.com/acme/y-harness' } },
      ],
    });
    const tournament = await createTournament(handle.db, req, { createdByUserId: null });
    const match = tournament.rounds[0]?.matches[0];
    if (!match) throw new Error('expected a round-0 match');

    const record = buildRecord({ winner: 'tie' });
    const result = await settleMatch(handle.db, match.id, record);
    expect(result?.winner).toBe(match.a);
    expect(result?.settledBy).toBe('seed');
    expect(result?.advancedTo).toBeNull();
    expect(result?.tournamentCompleted).toBe(true);

    const finished = await getTournament(handle.db, tournament.id);
    expect(finished?.winner).toBe(match.a);
    expect(finished?.status).toBe('completed');
    expect(finished?.completedAt).not.toBeNull();
  });
});
