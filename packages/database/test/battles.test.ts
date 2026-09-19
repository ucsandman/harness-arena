import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { EVENT_LIMITS, METRIC_KEYS, battleRecordSchema } from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import {
  battleRuns,
  battles,
  harnessVersions,
  harnesses,
  metrics,
  repositories,
  tasks,
} from '../src/schema/index.js';
import {
  countEvents,
  deleteBattle,
  getArtifact,
  getBattle,
  getBattleForViewer,
  getHarnessProfile,
  insertEvents,
  listArtifacts,
  listBattles,
  listEvents,
  listHarnesses,
  listUserBattles,
  setBattleVisibility,
  upsertArtifact,
  upsertBattleFromRecord,
  upsertGithubUser,
} from '../src/queries.js';
import { buildEvent, buildRecord, freshDb } from './helpers.js';

let handle: ArenaDb;

beforeEach(async () => {
  handle = await freshDb();
});

afterEach(async () => {
  await handle.close();
});

describe('upsertBattleFromRecord', () => {
  it('writes the battle and everything derived from a valid record', async () => {
    const record = buildRecord({
      category: 'debugging',
      harnessA: {
        name: 'superclaude',
        source: 'https://github.com/acme/superclaude',
        kind: 'github',
        commit: 'abc1234',
      },
      diffA: 'diff --git a/src/index.ts b/src/index.ts\n',
      finalResponseA: 'Fixed the parser.',
    });
    expect(battleRecordSchema.safeParse(record).success).toBe(true);

    const result = await upsertBattleFromRecord(handle.db, { record });
    expect(result.created).toBe(true);

    const found = await getBattle(handle.db, record.id);
    expect(found?.battle.title).toBe('Fix the failing parser test');
    expect(found?.battle.winner).toBe('a');
    expect(found?.battle.confidence).toBeCloseTo(0.8, 5);
    expect(found?.battle.category).toBe('debugging');
    expect(found?.battle.record.id).toBe(record.id);
    expect(found?.runs.map((run) => run.side)).toEqual(['a', 'b']);
    expect(found?.runs[0]?.durationMs).toBe(300_000);

    const taskRows = await handle.db.select().from(tasks);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.kind).toBe('prompt');

    const repoRows = await handle.db.select().from(repositories);
    expect(repoRows).toHaveLength(1);
    expect(repoRows[0]?.displayName).toBe('acme/widget');

    const harnessRows = await handle.db.select().from(harnesses).orderBy(harnesses.slug);
    expect(harnessRows.map((row) => row.slug)).toEqual(['acme--superclaude', 'vanilla']);
    expect(harnessRows.find((row) => row.slug === 'acme--superclaude')?.sourceKind).toBe('github');

    const versionRows = await handle.db.select().from(harnessVersions);
    expect(versionRows).toHaveLength(2);

    const metricRows = await handle.db.select().from(metrics).where(eq(metrics.battleId, record.id));
    expect(metricRows).toHaveLength(METRIC_KEYS.length * 2);
    const durationA = metricRows.find((row) => row.side === 'a' && row.key === 'duration_ms');
    expect(durationA?.value).toBe(300_000);
    expect(durationA?.status).toBe('calculated');
    const costA = metricRows.find((row) => row.side === 'a' && row.key === 'cost_usd');
    expect(costA?.status).toBe('unavailable');
    expect(costA?.value).toBeNull();
  });

  it('is idempotent and updates in place when the record changes', async () => {
    const record = buildRecord({ status: 'running', winner: null });
    const first = await upsertBattleFromRecord(handle.db, { record });
    expect(first.created).toBe(true);

    const finished = buildRecord({ id: record.id, status: 'completed', winner: 'b', confidence: 0.6 });
    const second = await upsertBattleFromRecord(handle.db, { record: finished });
    expect(second.created).toBe(false);

    const allBattles = await handle.db.select().from(battles);
    expect(allBattles).toHaveLength(1);
    expect(allBattles[0]?.status).toBe('completed');
    expect(allBattles[0]?.winner).toBe('b');

    const runs = await handle.db.select().from(battleRuns).where(eq(battleRuns.battleId, record.id));
    expect(runs).toHaveLength(2);
    const metricRows = await handle.db.select().from(metrics).where(eq(metrics.battleId, record.id));
    expect(metricRows).toHaveLength(METRIC_KEYS.length * 2);
  });

  it('rejects an id that is not a battle id', async () => {
    const record = buildRecord();
    const broken = { ...record, id: 'not-a-battle-id' } as typeof record;
    await expect(upsertBattleFromRecord(handle.db, { record: broken })).rejects.toThrow();
  });
});

describe('visibility', () => {
  it('lets only the owner read a private battle', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 1, login: 'owner' });
    const other = await upsertGithubUser(handle.db, { githubId: 2, login: 'other' });
    const record = buildRecord({ visibility: 'private' });
    await upsertBattleFromRecord(handle.db, { record, ownerUserId: owner.id });

    expect(await getBattleForViewer(handle.db, record.id, owner.id)).not.toBeNull();
    expect(await getBattleForViewer(handle.db, record.id, other.id)).toBeNull();
    expect(await getBattleForViewer(handle.db, record.id, null)).toBeNull();
  });

  it('lets anyone read unlisted and public battles', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 3, login: 'owner3' });
    const unlisted = buildRecord({ visibility: 'unlisted' });
    const open = buildRecord({ visibility: 'public' });
    await upsertBattleFromRecord(handle.db, { record: unlisted, ownerUserId: owner.id });
    await upsertBattleFromRecord(handle.db, { record: open, ownerUserId: owner.id });

    expect(await getBattleForViewer(handle.db, unlisted.id, null)).not.toBeNull();
    expect(await getBattleForViewer(handle.db, open.id, null)).not.toBeNull();
  });

  it('setBattleVisibility only works for the owner', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 4, login: 'owner4' });
    const record = buildRecord({ visibility: 'private' });
    await upsertBattleFromRecord(handle.db, { record, ownerUserId: owner.id });

    expect(await setBattleVisibility(handle.db, record.id, 'usr_someoneelse00', 'public')).toBe(false);
    expect(await setBattleVisibility(handle.db, record.id, owner.id, 'public')).toBe(true);
    const found = await getBattle(handle.db, record.id);
    expect(found?.battle.visibility).toBe('public');
  });

  it('deleteBattle removes the battle and its children', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 5, login: 'owner5' });
    const record = buildRecord({ visibility: 'public' });
    await upsertBattleFromRecord(handle.db, { record, ownerUserId: owner.id });
    await insertEvents(handle.db, record.id, [buildEvent(record.id, 0)]);

    expect(await deleteBattle(handle.db, record.id, 'usr_notowner00000')).toBe(false);
    expect(await deleteBattle(handle.db, record.id, owner.id)).toBe(true);
    expect(await getBattle(handle.db, record.id)).toBeNull();
    expect(await countEvents(handle.db, record.id)).toBe(0);
  });
});

describe('listBattles', () => {
  it('the public feed excludes private and unlisted battles', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 6, login: 'owner6' });
    const privateRecord = buildRecord({ visibility: 'private' });
    const unlistedRecord = buildRecord({ visibility: 'unlisted' });
    const publicRecord = buildRecord({ visibility: 'public' });
    for (const record of [privateRecord, unlistedRecord, publicRecord]) {
      await upsertBattleFromRecord(handle.db, { record, ownerUserId: owner.id });
    }

    const feed = await listBattles(handle.db, { limit: 10 });
    expect(feed.items.map((item) => item.id)).toEqual([publicRecord.id]);
    expect(feed.items[0]?.a.harness).toBe('vanilla');
    expect(feed.items[0]?.a.agent).toBe('claude-code');
    expect(feed.items[0]?.winner).toBe('a');

    const asOwner = await listBattles(handle.db, { viewerUserId: owner.id, limit: 10 });
    expect(asOwner.items).toHaveLength(3);

    const own = await listUserBattles(handle.db, owner.id);
    expect(own).toHaveLength(3);
  });

  it('pages with a cursor', async () => {
    const owner = await upsertGithubUser(handle.db, { githubId: 7, login: 'owner7' });
    for (let i = 0; i < 3; i++) {
      await upsertBattleFromRecord(handle.db, {
        record: buildRecord({ visibility: 'public' }),
        ownerUserId: owner.id,
      });
    }
    const first = await listBattles(handle.db, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await listBattles(handle.db, { limit: 2, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    const ids = new Set([...first.items, ...second.items].map((item) => item.id));
    expect(ids.size).toBe(3);
  });
});

describe('events', () => {
  it('deduplicates on (battle_id, seq) and tracks the count on the battle', async () => {
    const record = buildRecord({ visibility: 'public' });
    await upsertBattleFromRecord(handle.db, { record });
    const batch = [
      buildEvent(record.id, 0),
      buildEvent(record.id, 1),
      buildEvent(record.id, 2, 'agent.thinking'),
    ];

    const first = await insertEvents(handle.db, record.id, batch);
    expect(first).toMatchObject({ accepted: 3, rejected: 0, capped: false, lastSeq: 2 });

    const again = await insertEvents(handle.db, record.id, batch);
    expect(again).toMatchObject({ accepted: 0, rejected: 3, capped: false, lastSeq: 2 });

    expect(await countEvents(handle.db, record.id)).toBe(3);
    const found = await getBattle(handle.db, record.id);
    expect(found?.battle.eventCount).toBe(3);

    const listed = await listEvents(handle.db, record.id, { afterSeq: 0 });
    expect(listed.map((row) => row.seq)).toEqual([1, 2]);
    expect(listed[1]?.type).toBe('agent.thinking');
    expect(listed[1]?.payload).toEqual({ chars: 2 });
  });

  it('caps storage at EVENT_LIMITS.maxEventsPerBattle and reports the overflow', async () => {
    const record = buildRecord({ visibility: 'public' });
    await upsertBattleFromRecord(handle.db, { record });
    // Fill the battle to the cap directly; inserting 50k rows through the helper would be pointless work.
    await handle.db.execute(sql`
      insert into events (battle_id, seq, id, type, ts, t_offset_ms, source, confidence, payload)
      select ${record.id}, g, 'evt_' || lpad(to_hex(g), 8, '0'), 'warning', now(), 0,
             '{"adapter":"fake"}'::jsonb, 'observed', '{"message":"x"}'::jsonb
      from generate_series(1, ${EVENT_LIMITS.maxEventsPerBattle}) g
    `);
    expect(await countEvents(handle.db, record.id)).toBe(EVENT_LIMITS.maxEventsPerBattle);

    const result = await insertEvents(handle.db, record.id, [buildEvent(record.id, 0)]);
    expect(result).toMatchObject({ accepted: 0, rejected: 1, capped: true });
    expect(await countEvents(handle.db, record.id)).toBe(EVENT_LIMITS.maxEventsPerBattle);
    const found = await getBattle(handle.db, record.id);
    expect(found?.battle.eventsCapped).toBe(true);
  });

  it('refuses events for an unknown battle', async () => {
    await expect(insertEvents(handle.db, 'btl_0000000000000009', [])).rejects.toThrow(/unknown battle/);
  });
});

describe('artifacts', () => {
  it('upserts per (battle, side, kind) including battle-level artifacts', async () => {
    const record = buildRecord({ visibility: 'public' });
    await upsertBattleFromRecord(handle.db, { record });

    await upsertArtifact(handle.db, { battleId: record.id, side: 'a', kind: 'diff', content: 'one' });
    const updated = await upsertArtifact(handle.db, {
      battleId: record.id,
      side: 'a',
      kind: 'diff',
      content: 'two',
    });
    expect(updated.content).toBe('two');
    expect(updated.bytes).toBe(3);

    await upsertArtifact(handle.db, {
      battleId: record.id,
      side: null,
      kind: 'report_html',
      content: '<html></html>',
      contentType: 'text/html',
    });
    await upsertArtifact(handle.db, {
      battleId: record.id,
      side: null,
      kind: 'report_html',
      content: '<html>2</html>',
      contentType: 'text/html',
    });

    const listed = await listArtifacts(handle.db, record.id);
    expect(listed).toHaveLength(2);
    expect(await getArtifact(handle.db, record.id, 'a', 'diff')).toMatchObject({ content: 'two' });
    expect(await getArtifact(handle.db, record.id, null, 'report_html')).toMatchObject({
      content: '<html>2</html>',
      contentType: 'text/html',
    });
    expect(await getArtifact(handle.db, record.id, 'b', 'diff')).toBeNull();
  });
});

describe('harnesses', () => {
  it('lists harnesses and builds a profile with public battles only', async () => {
    const harnessA = {
      name: 'superclaude',
      source: 'https://github.com/acme/superclaude',
      kind: 'github' as const,
    };
    const publicRecord = buildRecord({ visibility: 'public', harnessA });
    const privateRecord = buildRecord({ visibility: 'private', harnessA });
    await upsertBattleFromRecord(handle.db, { record: publicRecord });
    await upsertBattleFromRecord(handle.db, { record: privateRecord });

    const all = await listHarnesses(handle.db, {});
    expect(all.map((row) => row.slug).sort()).toEqual(['acme--superclaude', 'vanilla']);

    const profile = await getHarnessProfile(handle.db, 'acme--superclaude');
    expect(profile?.harness.framework).toBe('claude-code');
    expect(profile?.versions).toHaveLength(1);
    expect(profile?.recentBattles.map((item) => item.id)).toEqual([publicRecord.id]);
    expect(profile?.ratings).toEqual([]);
    expect(await getHarnessProfile(handle.db, 'missing--harness')).toBeNull();
  });

  it('reuses one harness row across battles and keeps one version per commit', async () => {
    const harnessA = {
      name: 'superclaude',
      source: 'https://github.com/acme/superclaude',
      kind: 'github' as const,
      commit: 'abc1234',
    };
    await upsertBattleFromRecord(handle.db, { record: buildRecord({ harnessA }) });
    await upsertBattleFromRecord(handle.db, { record: buildRecord({ harnessA }) });

    const rows = await handle.db.select().from(harnesses).where(eq(harnesses.slug, 'acme--superclaude'));
    expect(rows).toHaveLength(1);
    const versions = await handle.db
      .select()
      .from(harnessVersions)
      .where(and(eq(harnessVersions.harnessId, rows[0]!.id), eq(harnessVersions.commit, 'abc1234')));
    expect(versions).toHaveLength(1);
    // vanilla has a null commit: the unique constraint is NULLS NOT DISTINCT, so it dedups too.
    expect(await handle.db.select().from(harnessVersions)).toHaveLength(2);
  });
});
