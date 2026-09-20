import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExperimentSummary } from '@harness-arena/protocol';
import {
  battleRecordSchema,
  createExperimentRequestSchema,
  experimentSummarySchema,
  harnessManifestSchema,
  makeId,
} from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import { experiments, harnessVersions } from '../src/schema/index.js';
import {
  componentSlug,
  getComponent,
  listComponents,
  upsertComponentsFromManifest,
} from '../src/components.js';
import { upsertBattleFromRecord } from '../src/queries.js';
import { buildRecord, freshDb } from './helpers.js';

describe('componentSlug', () => {
  it('lowercases kind and name into <kind>/<name>', () => {
    expect(componentSlug('Skill', 'Foo')).toBe('skill/foo');
  });
});

function makeSummary(correctnessDeltaPoints: number, tokenDeltaPercent: number): ExperimentSummary {
  const zeroStats = {
    n: 0,
    mean: null,
    median: null,
    variance: null,
    stddev: null,
    min: null,
    max: null,
    ci95: null,
  } as const;
  return experimentSummarySchema.parse({
    battles: 5,
    comparable: 5,
    wins: { control: 2, treatment: 3, ties: 0, inconclusive: 0 },
    correctness: {
      control: { n: 5, successes: 2, rate: 0.4, ci95: null },
      treatment: { n: 5, successes: 3, rate: 0.6, ci95: null },
      deltaPoints: correctnessDeltaPoints,
    },
    tokens: {
      control: { ...zeroStats, n: 5, mean: 1000 },
      treatment: { ...zeroStats, n: 5, mean: 900 },
      deltaPercent: tokenDeltaPercent,
      n: 5,
    },
    cost: { control: zeroStats, treatment: zeroStats, deltaPercent: null, n: 0 },
    duration: { control: zeroStats, treatment: zeroStats, deltaPercent: null, n: 0 },
    byCategory: [],
    evidence: { level: 'medium', n: 5, rationale: 'test fixture' },
    conclusions: ['treatment moved correctness by a measured amount'],
  });
}

describe('upsertComponentsFromManifest + listComponents/getComponent', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  async function versionIdFor(harnessId: string, commit: string): Promise<string> {
    const [row] = await handle.db
      .select()
      .from(harnessVersions)
      .where(and(eq(harnessVersions.harnessId, harnessId), eq(harnessVersions.commit, commit)));
    if (!row) throw new Error('versionIdFor: no harness version row');
    return row.id;
  }

  async function manifestBattle(source: string, commit: string) {
    const base = buildRecord({ harnessA: { name: 'x', source, kind: 'github', commit } });
    const manifest = harnessManifestSchema.parse({
      arena: 1,
      name: 'skilled',
      components: [{ kind: 'skill', name: 'Foo', path: 'skills/foo.md' }],
    });
    const record = battleRecordSchema.parse({
      ...base,
      runs: { ...base.runs, a: { ...base.runs.a, harness: { ...base.runs.a.harness, manifest } } },
    });
    return upsertBattleFromRecord(handle.db, { record });
  }

  it('writes component + harness_components rows and converges on a second call', async () => {
    const result = await manifestBattle('https://github.com/acme/skilled', 'abc1234');
    const versionId = await versionIdFor(result.harnessIds.a, 'abc1234');

    const manifest = harnessManifestSchema.parse({
      arena: 1,
      name: 'skilled',
      components: [{ kind: 'skill', name: 'Foo', path: 'skills/foo.md' }],
    });
    const first = await upsertComponentsFromManifest(handle.db, versionId, manifest);
    expect(first).toBe(1);
    const second = await upsertComponentsFromManifest(handle.db, versionId, manifest);
    expect(second).toBe(1);

    const list = await listComponents(handle.db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ slug: 'skill/foo', kind: 'skill', name: 'Foo', harnesses: 1 });
    expect(list[0]?.evidence).toEqual({
      experiments: 0,
      summarized: 0,
      correctnessDeltaPoints: null,
      tokenDeltaPercent: null,
    });
  });

  it('counts harnesses distinctly: two versions of the same harness count once', async () => {
    const first = await manifestBattle('https://github.com/acme/skilled2', 'abc1234');
    const versionId1 = await versionIdFor(first.harnessIds.a, 'abc1234');
    const manifest = harnessManifestSchema.parse({
      arena: 1,
      name: 'skilled2',
      components: [{ kind: 'skill', name: 'Foo', path: 'skills/foo.md' }],
    });
    await upsertComponentsFromManifest(handle.db, versionId1, manifest);

    // a second commit of the SAME harness (same source), declaring the same component
    const second = await manifestBattle('https://github.com/acme/skilled2', 'def5678');
    expect(second.harnessIds.a).toBe(first.harnessIds.a);
    const versionId2 = await versionIdFor(second.harnessIds.a, 'def5678');
    expect(versionId2).not.toBe(versionId1);
    await upsertComponentsFromManifest(handle.db, versionId2, manifest);

    const list = await listComponents(handle.db);
    expect(list).toHaveLength(1);
    expect(list[0]?.harnesses).toBe(1);

    const detail = await getComponent(handle.db, 'skill/foo');
    expect(detail?.harnessList).toHaveLength(2);
    expect(detail?.harnesses).toBe(1);
  });

  it('averages evidence over completed+summarized experiments only', async () => {
    const result = await manifestBattle('https://github.com/acme/skilled3', 'abc1234');
    const versionId = await versionIdFor(result.harnessIds.a, 'abc1234');
    const manifest = harnessManifestSchema.parse({
      arena: 1,
      name: 'skilled3',
      components: [{ kind: 'skill', name: 'Foo', path: 'skills/foo.md' }],
    });
    await upsertComponentsFromManifest(handle.db, versionId, manifest);

    const baseExperiment = createExperimentRequestSchema.parse({
      title: 'ablate the Foo skill',
      kind: 'ablation',
      control: { harness: { source: 'vanilla' } },
      treatment: { harness: { source: 'vanilla' } },
      changedComponent: { kind: 'skill', name: 'Foo' },
      agent: { id: 'claude-code' },
      target: {
        kind: 'task',
        task: { kind: 'prompt', prompt: 'x' },
        repository: { source: 'https://github.com/acme/widget' },
      },
    });

    const summary = makeSummary(12.5, -8.25);
    await handle.db.insert(experiments).values({
      id: makeId('experiment'),
      title: baseExperiment.title,
      kind: baseExperiment.kind,
      status: 'completed',
      control: baseExperiment.control,
      treatment: baseExperiment.treatment,
      changedComponent: baseExperiment.changedComponent ?? null,
      agent: baseExperiment.agent,
      target: baseExperiment.target,
      trials: baseExperiment.trials,
      visibility: baseExperiment.visibility,
      summary,
    });

    // a second, not-yet-summarized experiment on the same component must not move the averages
    await handle.db.insert(experiments).values({
      id: makeId('experiment'),
      title: 'a second ablation, still running',
      kind: baseExperiment.kind,
      status: 'planned',
      control: baseExperiment.control,
      treatment: baseExperiment.treatment,
      changedComponent: baseExperiment.changedComponent ?? null,
      agent: baseExperiment.agent,
      target: baseExperiment.target,
      trials: baseExperiment.trials,
      visibility: baseExperiment.visibility,
      summary: null,
    });

    const list = await listComponents(handle.db);
    const entry = list.find((c) => c.slug === 'skill/foo');
    expect(entry?.evidence).toEqual({
      experiments: 2,
      summarized: 1,
      correctnessDeltaPoints: 12.5,
      tokenDeltaPercent: -8.25,
    });

    const detail = await getComponent(handle.db, 'skill/foo');
    expect(detail?.experimentList).toHaveLength(2);
    const completedEntry = detail?.experimentList.find((e) => e.status === 'completed');
    expect(completedEntry).toMatchObject({
      correctnessDeltaPoints: 12.5,
      tokenDeltaPercent: -8.25,
      battles: 0,
    });
  });
});
