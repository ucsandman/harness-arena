import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  battleRecordSchema,
  createChallengeRequestSchema,
  createTournamentRequestSchema,
  harnessManifestSchema,
  makeId,
} from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import { afterBattleUpsert, battleLinksFor, linkBattleToArena } from '../src/links.js';
import { createChallenge } from '../src/challenges.js';
import { createTournament } from '../src/tournaments.js';
import { createExperiment } from '../src/experiments.js';
import { upsertBattleFromRecord, upsertGithubUser } from '../src/queries.js';
import { createExperimentRequestSchema } from '@harness-arena/protocol';
import { buildRecord, freshDb } from './helpers.js';

describe('linkBattleToArena: challenges', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  const target = {
    kind: 'task' as const,
    task: { kind: 'prompt' as const, prompt: 'Fix the failing parser test' },
    repository: { source: 'https://github.com/acme/widget' },
  };

  async function makeChallenge() {
    const req = createChallengeRequestSchema.parse({
      title: 'A vs B',
      sides: {
        a: { harness: { source: 'vanilla' } },
        b: { harness: { source: 'https://github.com/acme/challenger' } },
      },
      agent: { id: 'claude-code' },
      target,
    });
    return createChallenge(handle.db, req, { createdByUserId: null });
  }

  function withArenaLinks(record: ReturnType<typeof buildRecord>, arena: Record<string, string>) {
    return battleRecordSchema.parse({ ...record, spec: { ...record.spec, arena } });
  }

  it('links a battle that ran the challenge harnesses in either slot order, and is idempotent', async () => {
    const challenge = await makeChallenge();
    const swapped = buildRecord({
      harnessA: {
        name: 'challenger',
        source: 'https://github.com/acme/challenger',
        kind: 'github',
        commit: 'abc1234',
      },
      harnessB: { name: 'vanilla', source: 'vanilla', kind: 'vanilla' },
      winner: 'a',
    });
    const record = withArenaLinks(swapped, { challengeId: challenge.id });
    await upsertBattleFromRecord(handle.db, { record });

    const outcome = await linkBattleToArena(handle.db, record, { ownerUserId: null });
    expect(outcome.refused).toEqual([]);
    expect(outcome.linked).toEqual([{ kind: 'challenge', targetId: challenge.id }]);

    const links = await battleLinksFor(handle.db, record.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: 'challenge', targetId: challenge.id });

    const again = await linkBattleToArena(handle.db, record, { ownerUserId: null });
    expect(again.linked).toEqual([{ kind: 'challenge', targetId: challenge.id }]);
    const linksAfter = await battleLinksFor(handle.db, record.id);
    expect(linksAfter).toHaveLength(1);
  });

  it('refuses a battle that ran the wrong harness on one side, and writes no row', async () => {
    const challenge = await makeChallenge();
    const wrong = buildRecord({
      harnessB: { name: 'other', source: 'https://github.com/acme/other', kind: 'github', commit: 'abc1234' },
    });
    const record = withArenaLinks(wrong, { challengeId: challenge.id });
    await upsertBattleFromRecord(handle.db, { record });

    const outcome = await linkBattleToArena(handle.db, record, { ownerUserId: null });
    expect(outcome.linked).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]?.reason).toContain('did not run the two harnesses');

    const links = await battleLinksFor(handle.db, record.id);
    expect(links).toHaveLength(0);
  });

  it('refuses a battle whose agent differs from the challenge agent', async () => {
    const challenge = await makeChallenge();
    const wrongAgent = buildRecord({
      harnessB: {
        name: 'challenger',
        source: 'https://github.com/acme/challenger',
        kind: 'github',
        commit: 'abc1234',
      },
      agentA: 'codex',
      agentB: 'codex',
    });
    const record = withArenaLinks(wrongAgent, { challengeId: challenge.id });
    await upsertBattleFromRecord(handle.db, { record });

    const outcome = await linkBattleToArena(handle.db, record, { ownerUserId: null });
    expect(outcome.linked).toEqual([]);
    expect(outcome.refused[0]?.reason).toContain('the challenge is for agent claude-code');
  });
});

describe('linkBattleToArena: tournament matches', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  const target = {
    kind: 'task' as const,
    task: { kind: 'prompt' as const, prompt: 'Fix the failing parser test' },
    repository: { source: 'https://github.com/acme/widget' },
  };

  it('is slot-exact: entrant A must run as side A, and swapping sides is refused', async () => {
    const req = createTournamentRequestSchema.parse({
      name: 'Slot Cup',
      agent: { id: 'claude-code' },
      target,
      entrants: [
        { label: 'Left', harness: { source: 'https://github.com/acme/left' } },
        { label: 'Right', harness: { source: 'https://github.com/acme/right' } },
      ],
    });
    const tournament = await createTournament(handle.db, req, { createdByUserId: null });
    const match = tournament.rounds[0]?.matches[0];
    if (!match) throw new Error('expected a round-0 match');

    const straight = buildRecord({
      harnessA: { name: 'left', source: 'https://github.com/acme/left', kind: 'github', commit: 'abc1234' },
      harnessB: { name: 'right', source: 'https://github.com/acme/right', kind: 'github', commit: 'def5678' },
    });
    const straightRecord = battleRecordSchema.parse({
      ...straight,
      spec: { ...straight.spec, arena: { tournamentMatchId: match.id } },
    });
    await upsertBattleFromRecord(handle.db, { record: straightRecord });
    const outcome = await linkBattleToArena(handle.db, straightRecord, { ownerUserId: null });
    expect(outcome.linked).toEqual([{ kind: 'tournament_match', targetId: match.id }]);

    const swapped = buildRecord({
      harnessA: { name: 'right', source: 'https://github.com/acme/right', kind: 'github', commit: 'def5678' },
      harnessB: { name: 'left', source: 'https://github.com/acme/left', kind: 'github', commit: 'abc1234' },
    });
    const swappedRecord = battleRecordSchema.parse({
      ...swapped,
      spec: { ...swapped.spec, arena: { tournamentMatchId: match.id } },
    });
    await upsertBattleFromRecord(handle.db, { record: swappedRecord });
    const swappedOutcome = await linkBattleToArena(handle.db, swappedRecord, { ownerUserId: null });
    expect(swappedOutcome.linked).toEqual([]);
    expect(swappedOutcome.refused[0]?.reason).toContain('did not run');
  });
});

describe('linkBattleToArena: experiment refusal', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it('refuses an experimentId that names nothing, without throwing', async () => {
    const base = buildRecord();
    const record = battleRecordSchema.parse({
      ...base,
      spec: { ...base.spec, arena: { experimentId: makeId('experiment') } },
    });
    await upsertBattleFromRecord(handle.db, { record });

    const outcome = await linkBattleToArena(handle.db, record, { ownerUserId: null });
    expect(outcome.linked).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]?.reason).toBe('no experiment with that id');
  });
});

describe('afterBattleUpsert', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it('records manifest lineage and manifest components for both sides, and returns the counts', async () => {
    const manifestA = harnessManifestSchema.parse({
      arena: 1,
      name: 'sidea',
      lineage: { forkedFrom: 'https://github.com/acme/parent-a' },
      components: [{ kind: 'skill', name: 'Foo' }],
    });
    const manifestB = harnessManifestSchema.parse({
      arena: 1,
      name: 'sideb',
      lineage: { forkedFrom: 'https://github.com/acme/parent-b' },
      components: [{ kind: 'hook', name: 'Bar' }],
    });
    const base = buildRecord({
      harnessA: {
        name: 'sidea',
        source: 'https://github.com/acme/side-a',
        kind: 'github',
        commit: 'abc1234',
      },
      harnessB: {
        name: 'sideb',
        source: 'https://github.com/acme/side-b',
        kind: 'github',
        commit: 'def5678',
      },
    });
    const record = battleRecordSchema.parse({
      ...base,
      runs: {
        a: { ...base.runs.a, harness: { ...base.runs.a.harness, manifest: manifestA } },
        b: { ...base.runs.b, harness: { ...base.runs.b.harness, manifest: manifestB } },
      },
    });

    const result = await upsertBattleFromRecord(handle.db, { record });
    const outcome = await afterBattleUpsert(handle.db, record, {
      a: { harnessId: result.harnessIds.a },
      b: { harnessId: result.harnessIds.b },
    });

    expect(outcome.lineage).toEqual({ a: 1, b: 1 });
    expect(outcome.components).toEqual({ a: 1, b: 1 });
    expect(outcome.links).toEqual({ linked: [], refused: [] });
  });
});

/**
 * The seam between this workstream and the experiments module: links.ts resolves
 * `linkBattleToExperiment` at call time, so this test is what proves the two halves still meet.
 */
describe('linkBattleToArena: experiments', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it('links a battle to a real experiment and records which side was the treatment', async () => {
    const user = await upsertGithubUser(handle.db, {
      githubId: 77001,
      login: 'experimenter',
      name: null,
      avatarUrl: null,
      email: null,
    });
    const req = createExperimentRequestSchema.parse({
      title: 'before vs after',
      kind: 'comparison',
      control: { harness: { source: 'vanilla' } },
      treatment: { harness: { source: 'https://github.com/acme/treatment' } },
      agent: { id: 'claude-code' },
      target: {
        kind: 'task',
        task: { kind: 'prompt', prompt: 'Fix the failing parser test' },
        repository: { source: 'https://github.com/acme/widget' },
      },
    });
    const experiment = await createExperiment(handle.db, req, { createdByUserId: user.id });

    const base = buildRecord({
      harnessA: { name: 'vanilla', source: 'vanilla', kind: 'vanilla' },
      harnessB: {
        name: 'treatment',
        source: 'https://github.com/acme/treatment',
        kind: 'github',
        commit: 'abc1234',
      },
      winner: 'b',
    });
    const record = battleRecordSchema.parse({
      ...base,
      spec: { ...base.spec, arena: { experimentId: experiment.id } },
    });
    await upsertBattleFromRecord(handle.db, { record });

    const outcome = await linkBattleToArena(handle.db, record, { ownerUserId: user.id });
    expect(outcome.refused).toEqual([]);
    expect(outcome.linked).toEqual([{ kind: 'experiment', targetId: experiment.id }]);

    const links = await battleLinksFor(handle.db, record.id);
    expect(links).toHaveLength(1);
    // control ran as side A, so the treatment is side B
    expect(links[0]).toMatchObject({ kind: 'experiment', targetId: experiment.id, treatmentSide: 'b' });
  });

  it('refuses a battle that did not run the experiment control against its treatment', async () => {
    const user = await upsertGithubUser(handle.db, {
      githubId: 77002,
      login: 'experimenter-two',
      name: null,
      avatarUrl: null,
      email: null,
    });
    const req = createExperimentRequestSchema.parse({
      title: 'before vs after',
      kind: 'comparison',
      control: { harness: { source: 'vanilla' } },
      treatment: { harness: { source: 'https://github.com/acme/treatment' } },
      agent: { id: 'claude-code' },
      target: {
        kind: 'task',
        task: { kind: 'prompt', prompt: 'Fix the failing parser test' },
        repository: { source: 'https://github.com/acme/widget' },
      },
    });
    const experiment = await createExperiment(handle.db, req, { createdByUserId: user.id });

    const base = buildRecord({
      harnessB: {
        name: 'unrelated',
        source: 'https://github.com/acme/unrelated',
        kind: 'github',
        commit: 'abc1234',
      },
    });
    const record = battleRecordSchema.parse({
      ...base,
      spec: { ...base.spec, arena: { experimentId: experiment.id } },
    });
    await upsertBattleFromRecord(handle.db, { record });

    const outcome = await linkBattleToArena(handle.db, record, { ownerUserId: user.id });
    expect(outcome.linked).toEqual([]);
    expect(outcome.refused[0]?.reason).toContain('control against its treatment');
    expect(await battleLinksFor(handle.db, record.id)).toHaveLength(0);
  });
});
