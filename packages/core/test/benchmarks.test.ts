import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { battleSpecSchema, benchmarkPackSchema, benchmarkVersionId } from '@harness-arena/protocol';
import type { BenchmarkPack, BenchmarkPackInput, CompetitorSpec } from '@harness-arena/protocol';
import {
  BenchmarkPackError,
  expandBenchmark,
  experimentRecordPath,
  experimentRunRecordSchema,
  listExperimentRunRecords,
  loadBenchmarkPack,
  loadExperimentRunRecord,
  newExperimentId,
  parseBenchmarkPackText,
  saveExperimentRunRecord,
} from '../src/benchmarks.js';
import type { ExperimentRunRecordInput } from '../src/benchmarks.js';
import { removeDir, tempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_PACK_PATH = path.join(here, '../../../examples/benchmarks/arena-smoke/pack.yaml');

const competitorA: CompetitorSpec = {
  agent: { id: 'claude-code' },
  harness: { source: 'vanilla', trusted: false },
};
const competitorB: CompetitorSpec = {
  agent: { id: 'codex' },
  harness: { source: 'vanilla', trusted: false },
};

describe('loadBenchmarkPack', () => {
  it('loads the committed smoke pack from disk', async () => {
    const { pack, versionId } = await loadBenchmarkPack(SMOKE_PACK_PATH);
    expect(pack.slug).toBe('arena-smoke');
    expect(pack.tasks).toHaveLength(3);
    expect(versionId).toMatch(/^bmv_[0-9a-f]{24}$/);
  });
});

describe('benchmarkVersionId stability', () => {
  const rawPack: BenchmarkPackInput = {
    benchmark: 1,
    slug: 'stability-check',
    name: 'Stability check',
    version: '1.0.0',
    visibility: 'public',
    tasks: [
      {
        id: 'task-one',
        title: 'Task one',
        category: 'debugging',
        task: { kind: 'prompt', prompt: 'Do the thing.' },
        repository: { source: 'empty' },
      },
    ],
  };
  const pack = benchmarkPackSchema.parse(rawPack);

  it('is unaffected by key order and stray undefined values', async () => {
    const id1 = await benchmarkVersionId(pack);

    const reorderedTask = {
      trials: pack.tasks[0]!.trials,
      limits: pack.tasks[0]!.limits,
      evaluation: pack.tasks[0]!.evaluation,
      tags: pack.tasks[0]!.tags,
      repository: pack.tasks[0]!.repository,
      task: pack.tasks[0]!.task,
      category: pack.tasks[0]!.category,
      title: pack.tasks[0]!.title,
      id: pack.tasks[0]!.id,
    };
    const reorderedPack = {
      tasks: [reorderedTask],
      visibility: pack.visibility,
      version: pack.version,
      name: pack.name,
      slug: pack.slug,
      benchmark: pack.benchmark,
      extraneous: undefined,
    };
    const id2 = await benchmarkVersionId(reorderedPack as BenchmarkPack);
    expect(id2).toBe(id1);
  });

  it('changes when a task prompt changes by a single character', async () => {
    const id1 = await benchmarkVersionId(pack);
    const changed: BenchmarkPack = {
      ...pack,
      tasks: [
        {
          ...pack.tasks[0]!,
          task: {
            ...pack.tasks[0]!.task,
            prompt: (pack.tasks[0]!.task as { prompt: string }).prompt + '!',
          } as BenchmarkPack['tasks'][0]['task'],
        },
      ],
    };
    const id2 = await benchmarkVersionId(changed);
    expect(id2).not.toBe(id1);
  });
});

describe('expandBenchmark', () => {
  it('produces one spec per task in pack order, with full provenance', async () => {
    const { pack, versionId } = await loadBenchmarkPack(SMOKE_PACK_PATH);
    const specs = expandBenchmark(pack, versionId, { a: competitorA, b: competitorB });

    expect(specs).toHaveLength(3);
    expect(specs.map((spec) => spec.benchmark?.taskId)).toEqual([
      'debugging-notes',
      'refactoring-notes',
      'testing-notes',
    ]);

    for (const spec of specs) {
      expect(battleSpecSchema.safeParse(spec).success).toBe(true);
    }

    const first = specs[0]!;
    expect(first.category).toBe('debugging');
    expect(first.title).toBe('Arena smoke pack · Write a debugging note (trial 1)');
    expect(first.benchmark).toEqual({
      slug: 'arena-smoke',
      versionId,
      version: '1.0.0',
      taskId: 'debugging-notes',
      trial: 1,
    });
  });

  it('a trials override replaces the task trial count and numbers trials per task', async () => {
    const { pack, versionId } = await loadBenchmarkPack(SMOKE_PACK_PATH);
    const specs = expandBenchmark(pack, versionId, { a: competitorA, b: competitorB, trials: 3 });

    expect(specs).toHaveLength(9);
    expect(specs.map((spec) => spec.benchmark?.taskId)).toEqual([
      'debugging-notes',
      'debugging-notes',
      'debugging-notes',
      'refactoring-notes',
      'refactoring-notes',
      'refactoring-notes',
      'testing-notes',
      'testing-notes',
      'testing-notes',
    ]);
    expect(specs.map((spec) => spec.benchmark?.trial)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3]);
  });

  it('taskId selects one task', async () => {
    const { pack, versionId } = await loadBenchmarkPack(SMOKE_PACK_PATH);
    const specs = expandBenchmark(pack, versionId, {
      a: competitorA,
      b: competitorB,
      taskId: 'refactoring-notes',
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.benchmark?.taskId).toBe('refactoring-notes');
  });

  it('throws BenchmarkPackError for an unknown taskId', async () => {
    const { pack, versionId } = await loadBenchmarkPack(SMOKE_PACK_PATH);
    expect(() =>
      expandBenchmark(pack, versionId, { a: competitorA, b: competitorB, taskId: 'does-not-exist' }),
    ).toThrow(BenchmarkPackError);
  });

  it('passes the competitors through, applies an agent override to both sides, and links arena refs', async () => {
    const { pack, versionId } = await loadBenchmarkPack(SMOKE_PACK_PATH);
    const arena = { experimentId: 'exp_aaaaaaaa' };
    const specs = expandBenchmark(pack, versionId, {
      a: competitorA,
      b: competitorB,
      agent: { id: 'fake', model: 'test-model' },
      arena,
      taskId: 'testing-notes',
    });
    const spec = specs[0]!;
    expect(spec.competitors.a.agent).toEqual({ id: 'fake', model: 'test-model' });
    expect(spec.competitors.b.agent).toEqual({ id: 'fake', model: 'test-model' });
    expect(spec.competitors.a.harness).toEqual(competitorA.harness);
    expect(spec.competitors.b.harness).toEqual(competitorB.harness);
    expect(spec.arena).toEqual(arena);
  });
});

describe('parseBenchmarkPackText', () => {
  const validTask = {
    id: 'a-task',
    title: 'A task',
    category: 'debugging',
    task: { kind: 'prompt', prompt: 'Do something.' },
    repository: { source: 'empty' },
  };

  it('rejects a pack with a duplicate task id', () => {
    const raw = {
      benchmark: 1,
      slug: 'dup-check',
      name: 'Dup check',
      version: '1.0.0',
      tasks: [validTask, { ...validTask, title: 'A task again' }],
    };
    let caught: BenchmarkPackError | undefined;
    try {
      parseBenchmarkPackText(JSON.stringify(raw), 'dup.json');
    } catch (err) {
      caught = err as BenchmarkPackError;
    }
    expect(caught).toBeInstanceOf(BenchmarkPackError);
    expect(caught?.problems.some((p) => p.startsWith('tasks.1.id'))).toBe(true);
  });

  it('rejects a pack with a missing slug', () => {
    const raw = {
      benchmark: 1,
      name: 'No slug',
      version: '1.0.0',
      tasks: [validTask],
    };
    let caught: BenchmarkPackError | undefined;
    try {
      parseBenchmarkPackText(JSON.stringify(raw), 'no-slug.json');
    } catch (err) {
      caught = err as BenchmarkPackError;
    }
    expect(caught).toBeInstanceOf(BenchmarkPackError);
    expect(caught?.problems.some((p) => p.startsWith('slug'))).toBe(true);
  });
});

describe('ExperimentRunRecord persistence', () => {
  let home: string;

  beforeAll(() => {
    home = tempDir('experiment-records');
  });

  afterAll(() => {
    removeDir(home);
  });

  function makeRunRecord(overrides: Partial<ExperimentRunRecordInput> = {}): ExperimentRunRecordInput {
    return {
      version: 1,
      id: newExperimentId(),
      title: 'Test experiment run',
      kind: 'comparison',
      status: 'completed',
      control: { harness: { source: 'vanilla' } },
      treatment: { harness: { source: 'https://github.com/acme/widget' } },
      agent: { id: 'claude-code' },
      trials: 1,
      createdAt: new Date(Date.UTC(2000, 0, 1)).toISOString(),
      ...overrides,
    };
  }

  it('saves and loads the same record back', async () => {
    const record = makeRunRecord();
    const file = await saveExperimentRunRecord(home, record);
    expect(file).toBe(experimentRecordPath(home, record.id));

    const loaded = await loadExperimentRunRecord(home, record.id);
    expect(loaded).toEqual(experimentRunRecordSchema.parse(record));
  });

  it('returns null for an unknown id', async () => {
    expect(await loadExperimentRunRecord(home, newExperimentId())).toBeNull();
  });

  it('returns null for an id containing a path separator, never escaping the directory', async () => {
    expect(await loadExperimentRunRecord(home, '../../etc/passwd')).toBeNull();
    expect(await loadExperimentRunRecord(home, 'sub/dir')).toBeNull();
  });

  it('lists records newest first', async () => {
    const older = makeRunRecord({
      id: newExperimentId(),
      createdAt: new Date(Date.UTC(2010, 0, 1)).toISOString(),
    });
    const newer = makeRunRecord({
      id: newExperimentId(),
      createdAt: new Date(Date.UTC(2030, 0, 1)).toISOString(),
    });
    await saveExperimentRunRecord(home, older);
    await saveExperimentRunRecord(home, newer);

    const list = await listExperimentRunRecords(home, 10);
    expect(list[0]?.id).toBe(newer.id);
    expect(list.findIndex((r) => r.id === newer.id)).toBeLessThan(list.findIndex((r) => r.id === older.id));
  });
});
