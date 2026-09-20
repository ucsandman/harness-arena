import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { battleRecordSchema, createExperimentRequestSchema } from '@harness-arena/protocol';
import type {
  BattleRecord,
  MetricKey,
  MetricValue,
  RunStatus,
  Side,
  VerdictBreakdownRow,
} from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import {
  ExperimentLinkError,
  computeExperimentSummary,
  createExperiment,
  finalizeExperiment,
  getExperiment,
  linkBattleToExperiment,
  summarizeExperiment,
} from '../src/experiments.js';
import { upsertBattleFromRecord, upsertGithubUser } from '../src/queries.js';
import { buildRecord, freshDb } from './helpers.js';

// ---- pure math -----------------------------------------------------------------------------------

function withBreakdown(record: BattleRecord, breakdown: VerdictBreakdownRow[]): BattleRecord {
  return battleRecordSchema.parse({
    ...record,
    verdict: { ...record.verdict, breakdown },
  });
}

function withMetric(record: BattleRecord, side: Side, key: MetricKey, value: MetricValue): BattleRecord {
  return battleRecordSchema.parse({
    ...record,
    runs: {
      ...record.runs,
      [side]: { ...record.runs[side], metrics: { ...record.runs[side].metrics, [key]: value } },
    },
  });
}

function withRunStatus(record: BattleRecord, side: Side, status: RunStatus): BattleRecord {
  return battleRecordSchema.parse({
    ...record,
    runs: {
      ...record.runs,
      [side]: { ...record.runs[side], status },
    },
  });
}

describe('computeExperimentSummary', () => {
  it('over zero battles: no evidence and a plain "nothing yet" conclusion', () => {
    const summary = computeExperimentSummary([]);
    expect(summary.battles).toBe(0);
    expect(summary.evidence.level).toBe('none');
    expect(summary.conclusions).toEqual([
      'No battle reached a verdict, so this experiment shows nothing yet.',
    ]);
  });

  it('wins maps the verdict winner through treatmentSide, flipping when treatment is a', () => {
    // Both battles have the default winner "a"; only treatmentSide differs.
    const controlWinsBattle = buildRecord({ visibility: 'public' });
    const treatmentWinsBattle = buildRecord({ visibility: 'public' });
    const summary = computeExperimentSummary([
      { record: controlWinsBattle, treatmentSide: 'b' },
      { record: treatmentWinsBattle, treatmentSide: 'a' },
    ]);
    expect(summary.wins).toEqual({ control: 1, treatment: 1, ties: 0, inconclusive: 0 });
  });

  it('a side is correct when no correctness gate names the other side; n/a rows and un-run gates are excluded from the sample', () => {
    const gateForControl = withBreakdown(buildRecord({ visibility: 'public' }), [
      { factor: 'tests', result: 'b', detail: 'b passed the suite' },
    ]);
    const gateForTreatment = withBreakdown(buildRecord({ visibility: 'public' }), [
      { factor: 'tests', result: 'a', detail: 'a passed the suite' },
    ]);
    const naGate = withBreakdown(buildRecord({ visibility: 'public' }), [
      { factor: 'tests', result: 'n/a', detail: 'tests did not run' },
    ]);
    const noGate = buildRecord({ visibility: 'public' });

    const summary = computeExperimentSummary([
      { record: gateForControl, treatmentSide: 'a' },
      { record: gateForTreatment, treatmentSide: 'a' },
      { record: naGate, treatmentSide: 'a' },
      { record: noGate, treatmentSide: 'a' },
    ]);

    expect(summary.battles).toBe(4);
    expect(summary.correctness.control.n).toBe(2);
    expect(summary.correctness.treatment.n).toBe(2);
    expect(summary.correctness.control.successes).toBe(1);
    expect(summary.correctness.treatment.successes).toBe(1);
    expect(summary.correctness.deltaPoints).toBeCloseTo(0, 6);
  });

  it('comparable requires both runs completed, and a paired metric requires a real number on both sides', () => {
    const pairedTokens = (aValue: number, bValue: number): BattleRecord => {
      const base = buildRecord({ visibility: 'public' });
      const withA = withMetric(base, 'a', 'tokens_total', {
        value: aValue,
        status: 'observed',
        source: 'test',
      });
      return withMetric(withA, 'b', 'tokens_total', { value: bValue, status: 'observed', source: 'test' });
    };

    const battle1 = pairedTokens(1310, 1000);
    const battle2 = pairedTokens(1310, 1000);
    const battle3 = withMetric(pairedTokens(1310, 1000), 'a', 'tokens_total', {
      value: 5000,
      status: 'estimated',
      source: 'test',
      note: 'heuristic',
    });
    const incomplete = withRunStatus(buildRecord({ visibility: 'public' }), 'b', 'failed');

    const summary = computeExperimentSummary([
      { record: battle1, treatmentSide: 'a' },
      { record: battle2, treatmentSide: 'a' },
      { record: battle3, treatmentSide: 'a' },
      { record: incomplete, treatmentSide: 'a' },
    ]);

    expect(summary.comparable).toBe(3);
    expect(summary.tokens.n).toBe(2);
    expect(summary.tokens.deltaPercent).toBeCloseTo(0.31, 6);
  });

  it('byCategory buckets by spec.category, folding an unrecognised category into overall', () => {
    const debugging = buildRecord({ visibility: 'public', category: 'debugging' });
    const madeUp = buildRecord({ visibility: 'public', category: 'made-up-category' });
    const summary = computeExperimentSummary([
      { record: debugging, treatmentSide: 'a' },
      { record: madeUp, treatmentSide: 'a' },
    ]);
    expect(summary.byCategory.find((b) => b.category === 'debugging')?.battles).toBe(1);
    expect(summary.byCategory.find((b) => b.category === 'overall')?.battles).toBe(1);
  });

  it('the conclusions name the sample size behind them', () => {
    // A single battle with no correctness gate; duration_ms is always paired by buildRecord's fixture
    // (300_000ms on side a vs 240_000ms on side b), so a wall-clock sentence is expected too.
    const battle = buildRecord({ visibility: 'public' });
    const summary = computeExperimentSummary([{ record: battle, treatmentSide: 'a' }]);
    expect(summary.conclusions).toEqual([
      'No correctness gate (tests, assertions, build) ran in 1 battle(s), so correctness could not be compared.',
      'Treatment used 25% more wall-clock time without improving correctness (1 comparable battle).',
      'Wins: treatment 1, control 0, ties 0, inconclusive 0 over 1 decided battle(s).',
    ]);
  });
});

// ---- persistence -----------------------------------------------------------------------------------

const treatmentHarness = {
  name: 'widget-harness',
  source: 'https://github.com/acme/widget-harness',
  kind: 'github' as const,
};

function experimentRequest(overrides: { visibility?: 'private' | 'unlisted' | 'public' } = {}) {
  return createExperimentRequestSchema.parse({
    title: 'Widget harness vs vanilla',
    kind: 'comparison',
    control: { harness: { source: 'vanilla' } },
    treatment: { harness: { source: treatmentHarness.source } },
    agent: { id: 'claude-code' },
    target: {
      kind: 'task',
      task: { kind: 'prompt', prompt: 'Fix the bug.' },
      repository: { source: 'empty' },
    },
    ...(overrides.visibility ? { visibility: overrides.visibility } : {}),
  });
}

let handle: ArenaDb;

beforeEach(async () => {
  handle = await freshDb();
});

afterEach(async () => {
  await handle.close();
});

describe('createExperiment', () => {
  it('stores control, treatment and target and returns an Experiment', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 1, login: 'owner1' });
    const req = experimentRequest();
    const experiment = await createExperiment(handle.db, req, { createdByUserId: owner.id });

    expect(experiment.title).toBe(req.title);
    expect(experiment.control).toEqual(req.control);
    expect(experiment.treatment).toEqual(req.treatment);
    expect(experiment.target).toEqual(req.target);
    expect(experiment.status).toBe('running');
    expect(experiment.battleIds).toEqual([]);
    expect(experiment.summary).toBeNull();
  });
});

describe('linkBattleToExperiment', () => {
  it('accepts a battle whose run harness sources match control and treatment', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 2, login: 'owner2' });
    const experiment = await createExperiment(handle.db, experimentRequest(), { createdByUserId: owner.id });

    const matching = buildRecord({ visibility: 'public', harnessA: treatmentHarness });
    await upsertBattleFromRecord(handle.db, { record: matching });

    const link = await linkBattleToExperiment(handle.db, experiment.id, matching.id, 'a');
    expect(link).toEqual({ battleId: matching.id, treatmentSide: 'a' });
  });

  it('throws ExperimentLinkError when side a ran something other than the treatment', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 3, login: 'owner3' });
    const experiment = await createExperiment(handle.db, experimentRequest(), { createdByUserId: owner.id });

    const mismatched = buildRecord({
      visibility: 'public',
      harnessA: { name: 'other', source: 'https://github.com/other/other-harness', kind: 'github' },
    });
    await upsertBattleFromRecord(handle.db, { record: mismatched });

    await expect(linkBattleToExperiment(handle.db, experiment.id, mismatched.id, 'a')).rejects.toThrow(
      ExperimentLinkError,
    );
  });
});

describe('summarizeExperiment / finalizeExperiment', () => {
  it('summarizeExperiment recomputes from every battle linked to the experiment', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 4, login: 'owner4' });
    const experiment = await createExperiment(handle.db, experimentRequest(), { createdByUserId: owner.id });

    const treatmentWinBattle = buildRecord({ visibility: 'public', winner: 'a', harnessA: treatmentHarness });
    const controlWinBattle = buildRecord({ visibility: 'public', winner: 'b', harnessA: treatmentHarness });
    await upsertBattleFromRecord(handle.db, { record: treatmentWinBattle });
    await upsertBattleFromRecord(handle.db, { record: controlWinBattle });
    await linkBattleToExperiment(handle.db, experiment.id, treatmentWinBattle.id, 'a');
    await linkBattleToExperiment(handle.db, experiment.id, controlWinBattle.id, 'a');

    const summary = await summarizeExperiment(handle.db, experiment.id);
    expect(summary.battles).toBe(2);
    expect(summary.wins).toEqual({ control: 1, treatment: 1, ties: 0, inconclusive: 0 });
  });

  it('finalizeExperiment sets status completed, a non-null summary and completedAt', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 5, login: 'owner5' });
    const experiment = await createExperiment(handle.db, experimentRequest(), { createdByUserId: owner.id });

    const battle = buildRecord({ visibility: 'public', harnessA: treatmentHarness });
    await upsertBattleFromRecord(handle.db, { record: battle });
    await linkBattleToExperiment(handle.db, experiment.id, battle.id, 'a');

    const finalized = await finalizeExperiment(handle.db, experiment.id);
    expect(finalized?.status).toBe('completed');
    expect(finalized?.summary).not.toBeNull();
    expect(finalized?.completedAt).not.toBeNull();
  });
});

describe('getExperiment', () => {
  it('hides a private experiment from a different viewer and shows it to its creator', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 6, login: 'owner6' });
    const other = await upsertGithubUser(handle.db, { githubId: 7, login: 'other6' });
    const experiment = await createExperiment(handle.db, experimentRequest({ visibility: 'private' }), {
      createdByUserId: owner.id,
    });

    expect(await getExperiment(handle.db, experiment.id, owner.id)).not.toBeNull();
    expect(await getExperiment(handle.db, experiment.id, other.id)).toBeNull();
    expect(await getExperiment(handle.db, experiment.id)).toBeNull();
  });
});
