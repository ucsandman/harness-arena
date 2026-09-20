import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeId } from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import { harnesses } from '../src/schema/index.js';
import { getLineage, lineageFromGithub, lineageFromManifest, recordLineage } from '../src/lineage.js';
import { upsertBattleFromRecord } from '../src/queries.js';
import { buildRecord, freshDb } from './helpers.js';

describe('lineageFromManifest', () => {
  it('maps forkedFrom, derivedFrom and basedOn with evidence manifest', () => {
    const edges = lineageFromManifest({
      arena: 1,
      name: 'x',
      lineage: {
        forkedFrom: 'https://github.com/acme/parent',
        derivedFrom: ['https://github.com/acme/donor-a', 'https://github.com/acme/donor-b'],
        basedOn: ['https://github.com/acme/template'],
      },
    });
    expect(edges).toEqual([
      { relation: 'forked_from', parentSource: 'https://github.com/acme/parent', evidence: 'manifest' },
      { relation: 'derived_from', parentSource: 'https://github.com/acme/donor-a', evidence: 'manifest' },
      { relation: 'derived_from', parentSource: 'https://github.com/acme/donor-b', evidence: 'manifest' },
      { relation: 'based_on', parentSource: 'https://github.com/acme/template', evidence: 'manifest' },
    ]);
  });

  it('returns [] for an absent or empty lineage block', () => {
    expect(lineageFromManifest(null)).toEqual([]);
    expect(lineageFromManifest(undefined)).toEqual([]);
    expect(lineageFromManifest({ arena: 1, name: 'x' })).toEqual([]);
  });
});

describe('lineageFromGithub', () => {
  it('returns [] when the repository is not a fork', () => {
    expect(lineageFromGithub({ fork: false })).toEqual([]);
  });

  it('returns one forked_from edge with evidence github_fork when it is a fork', () => {
    expect(lineageFromGithub({ fork: true, parent: { html_url: 'https://github.com/acme/parent' } })).toEqual(
      [{ relation: 'forked_from', parentSource: 'https://github.com/acme/parent', evidence: 'github_fork' }],
    );
  });
});

describe('recordLineage + getLineage', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it('resolves the parent harness by slug, is idempotent, and refuses a self-edge', async () => {
    const child = buildRecord({
      harnessA: { name: 'child', source: 'https://github.com/acme/child', kind: 'github', commit: 'abc1234' },
    });
    const parent = buildRecord({
      harnessA: {
        name: 'parent',
        source: 'https://github.com/acme/parent-repo',
        kind: 'github',
        commit: 'def5678',
      },
    });
    const childResult = await upsertBattleFromRecord(handle.db, { record: child });
    await upsertBattleFromRecord(handle.db, { record: parent });

    const written = await recordLineage(handle.db, childResult.harnessIds.a, [
      { relation: 'forked_from', parentSource: 'https://github.com/acme/parent-repo', evidence: 'manifest' },
    ]);
    expect(written).toBe(1);

    const lineage = await getLineage(handle.db, 'acme--child');
    expect(lineage?.ancestors).toHaveLength(1);
    expect(lineage?.ancestors[0]).toMatchObject({
      relation: 'forked_from',
      parentSlug: 'acme--parent-repo',
      parentSource: 'https://github.com/acme/parent-repo',
      evidence: 'manifest',
    });

    const again = await recordLineage(handle.db, childResult.harnessIds.a, [
      { relation: 'forked_from', parentSource: 'https://github.com/acme/parent-repo', evidence: 'manifest' },
    ]);
    expect(again).toBe(1);
    const lineageAgain = await getLineage(handle.db, 'acme--child');
    expect(lineageAgain?.ancestors).toHaveLength(1);

    const selfWritten = await recordLineage(handle.db, childResult.harnessIds.a, [
      { relation: 'based_on', parentSource: 'https://github.com/acme/child', evidence: 'declared' },
    ]);
    expect(selfWritten).toBe(0);
    const lineageAfterSelf = await getLineage(handle.db, 'acme--child');
    expect(lineageAfterSelf?.ancestors).toHaveLength(1);
  });

  it('resolves the parent by stored sourceUrl when the declared slug does not match', async () => {
    const child = buildRecord({
      harnessA: {
        name: 'child2',
        source: 'https://github.com/acme/child2',
        kind: 'github',
        commit: 'abc1234',
      },
    });
    const childResult = await upsertBattleFromRecord(handle.db, { record: child });

    await handle.db.insert(harnesses).values({
      id: makeId('harness'),
      slug: 'totally-different-slug',
      name: 'Weird Parent',
      sourceKind: 'git',
      sourceUrl: 'https://example.com/acme/weird.git/',
    });

    const written = await recordLineage(handle.db, childResult.harnessIds.a, [
      { relation: 'derived_from', parentSource: 'https://example.com/acme/weird.git', evidence: 'manifest' },
    ]);
    expect(written).toBe(1);

    const lineage = await getLineage(handle.db, 'acme--child2');
    expect(lineage?.ancestors[0]).toMatchObject({
      relation: 'derived_from',
      parentSlug: 'totally-different-slug',
    });
  });

  it('leaves parentSlug null when the parent is not catalogued', async () => {
    const child = buildRecord({
      harnessA: {
        name: 'child3',
        source: 'https://github.com/acme/child3',
        kind: 'github',
        commit: 'abc1234',
      },
    });
    const childResult = await upsertBattleFromRecord(handle.db, { record: child });

    const written = await recordLineage(handle.db, childResult.harnessIds.a, [
      { relation: 'based_on', parentSource: 'https://github.com/acme/unknown-parent', evidence: 'declared' },
    ]);
    expect(written).toBe(1);

    const lineage = await getLineage(handle.db, 'acme--child3');
    expect(lineage?.ancestors[0]).toMatchObject({
      parentSlug: null,
      parentSource: 'https://github.com/acme/unknown-parent',
    });
  });

  it('getLineage reports descendants on the parent side', async () => {
    const child = buildRecord({
      harnessA: {
        name: 'child4',
        source: 'https://github.com/acme/child4',
        kind: 'github',
        commit: 'abc1234',
      },
    });
    const parent = buildRecord({
      harnessA: {
        name: 'parent4',
        source: 'https://github.com/acme/parent4',
        kind: 'github',
        commit: 'def5678',
      },
    });
    const childResult = await upsertBattleFromRecord(handle.db, { record: child });
    await upsertBattleFromRecord(handle.db, { record: parent });

    await recordLineage(handle.db, childResult.harnessIds.a, [
      { relation: 'forked_from', parentSource: 'https://github.com/acme/parent4', evidence: 'manifest' },
    ]);

    const parentLineage = await getLineage(handle.db, 'acme--parent4');
    expect(parentLineage?.descendants).toHaveLength(1);
    expect(parentLineage?.descendants[0]).toMatchObject({
      harnessSlug: 'acme--child4',
      relation: 'forked_from',
      parentSlug: 'acme--parent4',
    });
  });

  it('returns null for an uncatalogued slug', async () => {
    expect(await getLineage(handle.db, 'nope--nope')).toBeNull();
  });
});
