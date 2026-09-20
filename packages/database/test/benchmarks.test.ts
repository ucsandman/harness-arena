import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { benchmarkPackSchema, benchmarkVersionId } from '@harness-arena/protocol';
import type { BenchmarkPackInput } from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import {
  BenchmarkOwnershipError,
  getBenchmark,
  getBenchmarkVersion,
  listBenchmarks,
  publishBenchmark,
} from '../src/benchmarks.js';
import { upsertGithubUser } from '../src/queries.js';
import { benchmarkTasks, benchmarkVersions } from '../src/schema/index.js';
import { freshDb } from './helpers.js';

let handle: ArenaDb;

beforeEach(async () => {
  handle = await freshDb();
});

afterEach(async () => {
  await handle.close();
});

function makePackInput(overrides: Partial<BenchmarkPackInput> = {}): BenchmarkPackInput {
  return {
    benchmark: 1,
    slug: 'test-pack',
    name: 'Test pack',
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
    ...overrides,
  };
}

describe('publishBenchmark', () => {
  it('inserts benchmark, version and task rows on first publish', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 1, login: 'owner1' });
    const pack = benchmarkPackSchema.parse(makePackInput({ slug: 'publish-basic' }));
    const versionId = await benchmarkVersionId(pack);

    const result = await publishBenchmark(handle.db, pack, { ownerUserId: owner.id, versionId });
    expect(result.created).toBe(true);
    expect(result.benchmark.slug).toBe('publish-basic');
    expect(result.version.id).toBe(versionId);
    expect(result.summary.taskCount).toBe(1);
    expect(result.summary.battlesPerRun).toBe(1);

    const versionRows = await handle.db
      .select()
      .from(benchmarkVersions)
      .where(eq(benchmarkVersions.benchmarkId, result.benchmark.id));
    expect(versionRows).toHaveLength(1);

    const taskRows = await handle.db
      .select()
      .from(benchmarkTasks)
      .where(eq(benchmarkTasks.versionId, versionId));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.taskId).toBe('task-one');
  });

  it('publishing identical content again is a no-op', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 2, login: 'owner2' });
    const pack = benchmarkPackSchema.parse(makePackInput({ slug: 'publish-idempotent' }));
    const versionId = await benchmarkVersionId(pack);

    const first = await publishBenchmark(handle.db, pack, { ownerUserId: owner.id, versionId });
    expect(first.created).toBe(true);
    const second = await publishBenchmark(handle.db, pack, { ownerUserId: owner.id, versionId });
    expect(second.created).toBe(false);

    const versionRows = await handle.db
      .select()
      .from(benchmarkVersions)
      .where(eq(benchmarkVersions.benchmarkId, first.benchmark.id));
    expect(versionRows).toHaveLength(1);
  });

  it('publishing changed content under the same slug adds a version and moves latestVersionId', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 3, login: 'owner3' });
    const packV1 = benchmarkPackSchema.parse(makePackInput({ slug: 'publish-changed', version: '1.0.0' }));
    const versionId1 = await benchmarkVersionId(packV1);
    await publishBenchmark(handle.db, packV1, { ownerUserId: owner.id, versionId: versionId1 });

    const packV2 = benchmarkPackSchema.parse(makePackInput({ slug: 'publish-changed', version: '1.1.0' }));
    const versionId2 = await benchmarkVersionId(packV2);
    expect(versionId2).not.toBe(versionId1);

    const result = await publishBenchmark(handle.db, packV2, {
      ownerUserId: owner.id,
      versionId: versionId2,
    });
    expect(result.created).toBe(true);
    expect(result.benchmark.latestVersionId).toBe(versionId2);

    const versionRows = await handle.db
      .select()
      .from(benchmarkVersions)
      .where(eq(benchmarkVersions.benchmarkId, result.benchmark.id));
    expect(versionRows).toHaveLength(2);
  });

  it('throws BenchmarkOwnershipError when a different user publishes to an existing slug', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 4, login: 'owner4' });
    const intruder = await upsertGithubUser(handle.db, { githubId: 5, login: 'intruder4' });
    const pack = benchmarkPackSchema.parse(makePackInput({ slug: 'publish-owned' }));
    const versionId = await benchmarkVersionId(pack);
    await publishBenchmark(handle.db, pack, { ownerUserId: owner.id, versionId });

    const changed = benchmarkPackSchema.parse(makePackInput({ slug: 'publish-owned', version: '2.0.0' }));
    const changedVersionId = await benchmarkVersionId(changed);
    await expect(
      publishBenchmark(handle.db, changed, { ownerUserId: intruder.id, versionId: changedVersionId }),
    ).rejects.toThrow(BenchmarkOwnershipError);
  });
});

describe('getBenchmark / getBenchmarkVersion / listBenchmarks', () => {
  it('getBenchmark returns the latest version by default, a requested version, ordered tasks and version history', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 6, login: 'owner6' });
    const tasksInOrder: BenchmarkPackInput['tasks'] = [
      {
        id: 'task-b',
        title: 'Task B',
        category: 'testing',
        task: { kind: 'prompt', prompt: 'b' },
        repository: { source: 'empty' },
      },
      {
        id: 'task-a',
        title: 'Task A',
        category: 'debugging',
        task: { kind: 'prompt', prompt: 'a' },
        repository: { source: 'empty' },
      },
    ];
    const packV1 = benchmarkPackSchema.parse(
      makePackInput({ slug: 'get-benchmark', version: '1.0.0', tasks: tasksInOrder }),
    );
    const versionId1 = await benchmarkVersionId(packV1);
    await publishBenchmark(handle.db, packV1, { ownerUserId: owner.id, versionId: versionId1 });

    const packV2 = benchmarkPackSchema.parse(
      makePackInput({ slug: 'get-benchmark', version: '2.0.0', tasks: tasksInOrder }),
    );
    const versionId2 = await benchmarkVersionId(packV2);
    await publishBenchmark(handle.db, packV2, { ownerUserId: owner.id, versionId: versionId2 });

    const latest = await getBenchmark(handle.db, 'get-benchmark');
    expect(latest?.version.id).toBe(versionId2);
    expect(latest?.tasks.map((task) => task.taskId)).toEqual(['task-b', 'task-a']);
    expect(latest?.versions.map((v) => v.versionId).sort()).toEqual([versionId1, versionId2].sort());

    const specific = await getBenchmark(handle.db, 'get-benchmark', { versionId: versionId1 });
    expect(specific?.version.id).toBe(versionId1);
  });

  it('listBenchmarks respects visibility and category filters and the limit', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 7, login: 'owner7' });
    const pub = benchmarkPackSchema.parse(
      makePackInput({
        slug: 'list-pub',
        visibility: 'public',
        tasks: [
          {
            id: 'task-one',
            title: 'Task one',
            category: 'debugging',
            task: { kind: 'prompt', prompt: 'a' },
            repository: { source: 'empty' },
          },
        ],
      }),
    );
    const unlisted = benchmarkPackSchema.parse(
      makePackInput({
        slug: 'list-unlisted',
        visibility: 'unlisted',
        tasks: [
          {
            id: 'task-one',
            title: 'Task one',
            category: 'testing',
            task: { kind: 'prompt', prompt: 'b' },
            repository: { source: 'empty' },
          },
        ],
      }),
    );
    await publishBenchmark(handle.db, pub, {
      ownerUserId: owner.id,
      versionId: await benchmarkVersionId(pub),
    });
    await publishBenchmark(handle.db, unlisted, {
      ownerUserId: owner.id,
      versionId: await benchmarkVersionId(unlisted),
    });

    const publicOnly = await listBenchmarks(handle.db, { visibility: 'public' });
    expect(publicOnly.map((s) => s.slug)).toEqual(['list-pub']);

    const debuggingOnly = await listBenchmarks(handle.db, { category: 'debugging' });
    expect(debuggingOnly.map((s) => s.slug)).toContain('list-pub');
    expect(debuggingOnly.map((s) => s.slug)).not.toContain('list-unlisted');

    const limited = await listBenchmarks(handle.db, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('a private pack is visible only to its owner, in listBenchmarks, getBenchmark and getBenchmarkVersion', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 8, login: 'owner8' });
    const other = await upsertGithubUser(handle.db, { githubId: 9, login: 'other8' });
    const pack = benchmarkPackSchema.parse(makePackInput({ slug: 'private-pack', visibility: 'private' }));
    const versionId = await benchmarkVersionId(pack);
    await publishBenchmark(handle.db, pack, { ownerUserId: owner.id, versionId });

    expect(await getBenchmark(handle.db, 'private-pack', { viewerUserId: owner.id })).not.toBeNull();
    expect(await getBenchmark(handle.db, 'private-pack', { viewerUserId: other.id })).toBeNull();
    expect(await getBenchmark(handle.db, 'private-pack')).toBeNull();

    expect(await getBenchmarkVersion(handle.db, versionId, owner.id)).not.toBeNull();
    expect(await getBenchmarkVersion(handle.db, versionId, other.id)).toBeNull();
    expect(await getBenchmarkVersion(handle.db, versionId)).toBeNull();

    const asOwner = await listBenchmarks(handle.db, { viewerUserId: owner.id });
    expect(asOwner.map((s) => s.slug)).toContain('private-pack');
    const asOther = await listBenchmarks(handle.db, { viewerUserId: other.id });
    expect(asOther.map((s) => s.slug)).not.toContain('private-pack');
    const anon = await listBenchmarks(handle.db);
    expect(anon.map((s) => s.slug)).not.toContain('private-pack');
  });
});
