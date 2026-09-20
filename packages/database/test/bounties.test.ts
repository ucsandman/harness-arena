import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BattleRecord, BountyCondition } from '@harness-arena/protocol';
import { battleRecordSchema, createBountyRequestSchema } from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import type { BountyBattle } from '../src/bounties.js';
import {
  awardBounty,
  createBounty,
  evaluateBountyCondition,
  evaluateSubmission,
  submitToBounty,
} from '../src/bounties.js';
import { battleLinks } from '../src/schema/index.js';
import { upsertBattleFromRecord, upsertGithubUser } from '../src/queries.js';
import { buildRecord, freshDb } from './helpers.js';

function withTokens(record: BattleRecord, tokensA: number | null, tokensB: number | null): BattleRecord {
  return battleRecordSchema.parse({
    ...record,
    runs: {
      ...record.runs,
      a: {
        ...record.runs.a,
        metrics: {
          ...record.runs.a.metrics,
          tokens_total:
            tokensA === null
              ? { value: null, status: 'unavailable' }
              : { value: tokensA, status: 'observed', source: 'test' },
        },
      },
      b: {
        ...record.runs.b,
        metrics: {
          ...record.runs.b.metrics,
          tokens_total:
            tokensB === null
              ? { value: null, status: 'unavailable' }
              : { value: tokensB, status: 'observed', source: 'test' },
        },
      },
    },
  });
}

describe('evaluateBountyCondition', () => {
  it('mustWin every: met when the submission won every battle', () => {
    const list: BountyBattle[] = [
      { record: buildRecord({ winner: 'b' }), submissionSide: 'b' },
      { record: buildRecord({ winner: 'b' }), submissionSide: 'b' },
    ];
    const result = evaluateBountyCondition({ mustWin: 'every', minBattles: 1 }, list);
    expect(result.met).toBe(true);
    expect(result.battles).toBe(2);
  });

  it('mustWin every: not met when one battle was lost', () => {
    const list: BountyBattle[] = [
      { record: buildRecord({ winner: 'b' }), submissionSide: 'b' },
      { record: buildRecord({ winner: 'a' }), submissionSide: 'b' },
    ];
    const result = evaluateBountyCondition({ mustWin: 'every', minBattles: 1 }, list);
    expect(result.met).toBe(false);
  });

  it('mustWin majority: met with more wins than losses', () => {
    const list: BountyBattle[] = [
      { record: buildRecord({ winner: 'b' }), submissionSide: 'b' },
      { record: buildRecord({ winner: 'b' }), submissionSide: 'b' },
      { record: buildRecord({ winner: 'a' }), submissionSide: 'b' },
    ];
    const result = evaluateBountyCondition({ mustWin: 'majority', minBattles: 1 }, list);
    expect(result.met).toBe(true);
  });

  it('mustWin majority: not met when losses meet or exceed wins', () => {
    const list: BountyBattle[] = [
      { record: buildRecord({ winner: 'b' }), submissionSide: 'b' },
      { record: buildRecord({ winner: 'a' }), submissionSide: 'b' },
    ];
    const result = evaluateBountyCondition({ mustWin: 'majority', minBattles: 1 }, list);
    expect(result.met).toBe(false);
  });

  it('minBattles: not met below the threshold', () => {
    const list: BountyBattle[] = [{ record: buildRecord({ winner: 'b' }), submissionSide: 'b' }];
    const result = evaluateBountyCondition({ mustWin: 'every', minBattles: 3 }, list);
    expect(result.met).toBe(false);
    expect(result.reasons.some((r) => r.includes('minBattles 3'))).toBe(true);
  });

  it('a tokens ratio that is met', () => {
    const list: BountyBattle[] = [
      { record: withTokens(buildRecord({ winner: 'b' }), 1000, 700), submissionSide: 'b' },
    ];
    const result = evaluateBountyCondition({ mustWin: 'every', minBattles: 1, maxTokensRatio: 0.8 }, list);
    expect(result.met).toBe(true);
  });

  it('a tokens ratio that is not met', () => {
    const list: BountyBattle[] = [
      { record: withTokens(buildRecord({ winner: 'b' }), 1000, 950), submissionSide: 'b' },
    ];
    const result = evaluateBountyCondition({ mustWin: 'every', minBattles: 1, maxTokensRatio: 0.8 }, list);
    expect(result.met).toBe(false);
  });

  it('a tokens ratio is not met when no battle reports it on both sides', () => {
    const list: BountyBattle[] = [
      { record: withTokens(buildRecord({ winner: 'b' }), null, 700), submissionSide: 'b' },
      { record: withTokens(buildRecord({ winner: 'b' }), 1000, null), submissionSide: 'b' },
    ];
    const result = evaluateBountyCondition({ mustWin: 'every', minBattles: 1, maxTokensRatio: 0.8 }, list);
    expect(result.met).toBe(false);
    const reason = result.reasons.find((r) => r.startsWith('tokens ratio'));
    expect(reason).toContain('0 of 2');
  });

  it('every reason carries the numbers it was decided on', () => {
    const list: BountyBattle[] = [
      { record: withTokens(buildRecord({ winner: 'b' }), 1000, 700), submissionSide: 'b' },
    ];
    const condition: BountyCondition = { mustWin: 'every', minBattles: 1, maxTokensRatio: 0.8 };
    const result = evaluateBountyCondition(condition, list);
    for (const reason of result.reasons) {
      expect(reason).toMatch(/\d/);
    }
  });
});

describe('bounty DB flow', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  const target = {
    kind: 'task' as const,
    task: { kind: 'prompt' as const, prompt: 'Beat the baseline' },
    repository: { source: 'https://github.com/acme/widget' },
  };

  it('createBounty -> submitToBounty -> link a battle -> evaluateSubmission -> awardBounty', async () => {
    const creator = await upsertGithubUser(handle.db, { githubId: 1, login: 'poster' });
    const stranger = await upsertGithubUser(handle.db, { githubId: 2, login: 'stranger' });

    const req = createBountyRequestSchema.parse({
      title: 'Beat vanilla',
      baseline: { harness: { source: 'vanilla' } },
      agent: { id: 'claude-code' },
      target,
      condition: { mustWin: 'every', minBattles: 1 },
      reward: { kind: 'reputation', description: 'bragging rights' },
    });
    const bounty = await createBounty(handle.db, req, { createdByUserId: creator.id });
    expect(bounty.status).toBe('open');

    const submissionOutcome = await submitToBounty(
      handle.db,
      bounty.id,
      { harness: { harness: { source: 'https://github.com/acme/challenger' } } },
      { userId: creator.id },
    );
    if (!submissionOutcome.ok) throw new Error('submitToBounty failed');
    const submission = submissionOutcome.value;

    const battle = buildRecord({
      harnessB: {
        name: 'challenger',
        source: 'https://github.com/acme/challenger',
        kind: 'github',
        commit: 'abc1234',
      },
      winner: 'b',
    });
    await upsertBattleFromRecord(handle.db, { record: battle });
    await handle.db
      .insert(battleLinks)
      .values({ battleId: battle.id, kind: 'bounty_submission', targetId: submission.id });

    const evaluated = await evaluateSubmission(handle.db, submission.id);
    expect(evaluated?.result).toMatchObject({ met: true, battles: 1 });

    const forbidden = await awardBounty(handle.db, bounty.id, submission.id, stranger.id);
    expect(forbidden).toMatchObject({ ok: false, code: 'forbidden' });

    const awarded = await awardBounty(handle.db, bounty.id, submission.id, creator.id);
    expect(awarded.ok).toBe(true);
    if (awarded.ok) {
      expect(awarded.value.bounty.status).toBe('awarded');
    }
  });

  it('awardBounty refuses a submission that does not meet the condition', async () => {
    const creator = await upsertGithubUser(handle.db, { githubId: 3, login: 'poster2' });
    const req = createBountyRequestSchema.parse({
      title: 'Beat vanilla again',
      baseline: { harness: { source: 'vanilla' } },
      agent: { id: 'claude-code' },
      target,
      condition: { mustWin: 'every', minBattles: 1 },
      reward: { kind: 'reputation', description: 'bragging rights' },
    });
    const bounty = await createBounty(handle.db, req, { createdByUserId: creator.id });

    const submissionOutcome = await submitToBounty(
      handle.db,
      bounty.id,
      { harness: { harness: { source: 'https://github.com/acme/loser' } } },
      { userId: creator.id },
    );
    if (!submissionOutcome.ok) throw new Error('submitToBounty failed');
    const submission = submissionOutcome.value;

    const battle = buildRecord({
      harnessB: { name: 'loser', source: 'https://github.com/acme/loser', kind: 'github', commit: 'abc1234' },
      winner: 'a',
    });
    await upsertBattleFromRecord(handle.db, { record: battle });
    await handle.db
      .insert(battleLinks)
      .values({ battleId: battle.id, kind: 'bounty_submission', targetId: submission.id });

    const result = await awardBounty(handle.db, bounty.id, submission.id, creator.id);
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
  });
});
