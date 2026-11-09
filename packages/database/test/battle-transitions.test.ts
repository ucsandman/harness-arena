import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { IllegalTransitionError } from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import { battleRuns, battles } from '../src/schema/index.js';
import { upsertBattleFromRecord } from '../src/queries.js';
import { buildRecord, freshDb } from './helpers.js';

let handle: ArenaDb;

beforeEach(async () => {
  handle = await freshDb();
});

afterEach(async () => {
  await handle.close();
});

async function snapshot(id: string) {
  const [row] = await handle.db
    .select({ status: battles.status, record: battles.record, winner: battles.winner })
    .from(battles)
    .where(eq(battles.id, id));
  const runs = await handle.db
    .select()
    .from(battleRuns)
    .where(eq(battleRuns.battleId, id))
    .orderBy(battleRuns.side);
  return { row, runs };
}

describe('upsertBattleFromRecord follows BATTLE_TRANSITIONS', () => {
  it('refuses completed -> running and rolls the whole write back', async () => {
    const record = buildRecord({ status: 'completed', winner: 'a' });
    await upsertBattleFromRecord(handle.db, { record });
    const before = await snapshot(record.id);
    expect(before.row?.status).toBe('completed');
    expect(before.runs).toHaveLength(2);

    const backwards = buildRecord({ id: record.id, status: 'running', winner: 'b', modelA: 'other-model' });
    let caught: unknown;
    try {
      await upsertBattleFromRecord(handle.db, { record: backwards });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    expect(caught).toMatchObject({
      code: 'illegal_transition',
      current: 'completed',
      requested: 'running',
      allowed: [],
    });

    expect(await snapshot(record.id)).toEqual(before);
  });

  it('refuses failed -> completed', async () => {
    const record = buildRecord({ status: 'failed', winner: null });
    await upsertBattleFromRecord(handle.db, { record });
    await expect(
      upsertBattleFromRecord(handle.db, { record: buildRecord({ id: record.id, status: 'completed' }) }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await snapshot(record.id)).row?.status).toBe('failed');
  });

  it('accepts running -> completed', async () => {
    const record = buildRecord({ status: 'running', winner: null });
    await upsertBattleFromRecord(handle.db, { record });
    const result = await upsertBattleFromRecord(handle.db, {
      record: buildRecord({ id: record.id, status: 'completed', winner: 'b' }),
    });
    expect(result.created).toBe(false);
    const after = await snapshot(record.id);
    expect(after.row?.status).toBe('completed');
    expect(after.row?.winner).toBe('b');
  });

  it('accepts pending -> completed (the engine registers pending, then uploads once at the end)', async () => {
    const record = buildRecord({ status: 'pending', winner: null });
    await upsertBattleFromRecord(handle.db, { record });
    await upsertBattleFromRecord(handle.db, { record: buildRecord({ id: record.id, status: 'completed' }) });
    expect((await snapshot(record.id)).row?.status).toBe('completed');
  });

  it('accepts re-writing the same terminal status (a retry or a re-seed)', async () => {
    const record = buildRecord({ status: 'completed', winner: 'a' });
    await upsertBattleFromRecord(handle.db, { record });
    const again = await upsertBattleFromRecord(handle.db, { record, visibility: 'public' });
    expect(again.created).toBe(false);
    const [row] = await handle.db
      .select({ status: battles.status, visibility: battles.visibility })
      .from(battles)
      .where(eq(battles.id, record.id));
    expect(row).toEqual({ status: 'completed', visibility: 'public' });
  });
});
