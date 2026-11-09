import './setup-env';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import {
  BATTLE_INITIAL_STATUS,
  BATTLE_STATUSES,
  BATTLE_STATUS_LABELS,
  battleRecordSchema,
  isLiveBattleStatus,
  nextBattleStatuses,
  type BattleRecord,
  type BattleStatus,
} from '@harness-arena/protocol';
import { getBattle, ratingEvents, ratings, upsertBattleFromRecord } from '@harness-arena/database';
import { POST as createBattle } from '@/app/api/v1/battles/route';
import { GET as readBattle, PATCH as patchBattle } from '@/app/api/v1/battles/[id]/route';
import { resetRateLimits } from '@/lib/api';
import { BattleStatusBadge } from '@/components/battles/BattleList';
import {
  demoRecord,
  freshBattleId,
  getRequest,
  jsonOf,
  jsonRequest,
  makeDevice,
  params,
  ratableRecord,
  testDb,
} from './helpers';

/** The battle page reads the session through getCurrentUser; there is no request scope in a unit test. */
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return { ...actual, getCurrentUser: async () => null };
});

const { default: BattlePage } = await import('../app/battles/[id]/page');

interface TransitionErrorBody {
  error: { code: string; message: string; current?: string; requested?: string; allowed?: string[] };
}

function withStatus(record: BattleRecord, status: BattleStatus): BattleRecord {
  return battleRecordSchema.parse({ ...record, status });
}

function publicRecord(record: BattleRecord): BattleRecord {
  return battleRecordSchema.parse({ ...record, spec: { ...record.spec, visibility: 'public' } });
}

describe('battle lifecycle over REST', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('refuses a status-only PATCH that moves a completed battle back to running', async () => {
    const owner = await makeDevice('lifecycle-owner-1', 9901);
    const id = freshBattleId();
    const record = demoRecord({ id, demo: false });
    expect(record.status).toBe('completed');
    const created = await createBattle(jsonRequest('/api/v1/battles', { record }, { token: owner.token }));
    expect(created.status).toBe(201);

    const refused = await patchBattle(
      jsonRequest(`/api/v1/battles/${id}`, { status: 'running' }, { method: 'PATCH', token: owner.token }),
      params({ id }),
    );
    expect(refused.status).toBe(409);
    const body = await jsonOf<TransitionErrorBody>(refused);
    expect(body.error).toMatchObject({
      code: 'illegal_transition',
      current: 'completed',
      requested: 'running',
      allowed: [],
    });
    expect(body.error.message).toBe(`battle ${id}: completed cannot become running; completed is final`);

    const read = await readBattle(
      getRequest(`/api/v1/battles/${id}`, { token: owner.token }),
      params({ id }),
    );
    expect(read.status).toBe(200);
    const detail = await jsonOf<{ record: BattleRecord; allowedNext: string[] }>(read);
    expect(detail.record.status).toBe('completed');
    expect(detail.record.verdict?.winner).toBe(record.verdict?.winner);
    expect(detail.allowedNext).toEqual([]);
    const stored = await getBattle(await testDb(), id);
    expect(stored?.battle.status).toBe('completed');
    expect(stored?.battle.winner).toBe(record.verdict?.winner ?? null);
  });

  it('refuses a status-only PATCH from failed to completed and leaves the ratings alone', async () => {
    const owner = await makeDevice('lifecycle-owner-2', 9902);
    const dbh = await testDb();
    const id = freshBattleId();
    // public, non-demo and ratable: were the PATCH accepted, the route would rate it
    const record = withStatus(publicRecord(ratableRecord({ id, demo: false })), 'failed');
    const created = await createBattle(jsonRequest('/api/v1/battles', { record }, { token: owner.token }));
    expect(created.status).toBe(201);

    const ratingsBefore = await dbh.select().from(ratings);
    const eventsBefore = await dbh.select().from(ratingEvents);

    const refused = await patchBattle(
      jsonRequest(`/api/v1/battles/${id}`, { status: 'completed' }, { method: 'PATCH', token: owner.token }),
      params({ id }),
    );
    expect(refused.status).toBe(409);
    const body = await jsonOf<TransitionErrorBody>(refused);
    expect(body.error).toMatchObject({
      code: 'illegal_transition',
      current: 'failed',
      requested: 'completed',
      allowed: [],
    });

    expect(await dbh.select().from(ratings)).toEqual(ratingsBefore);
    expect(await dbh.select().from(ratingEvents)).toEqual(eventsBefore);
    expect((await getBattle(dbh, id))?.battle.status).toBe('failed');
  });

  it('refuses a POST that re-uploads a pending record over an owned completed battle', async () => {
    const owner = await makeDevice('lifecycle-owner-3', 9903);
    const id = freshBattleId();
    const record = demoRecord({ id, demo: false });
    const created = await createBattle(jsonRequest('/api/v1/battles', { record }, { token: owner.token }));
    expect(created.status).toBe(201);

    const stale = withStatus(record, 'pending');
    const refused = await createBattle(
      jsonRequest('/api/v1/battles', { record: stale }, { token: owner.token }),
    );
    expect(refused.status).toBe(409);
    const body = await jsonOf<TransitionErrorBody>(refused);
    expect(body.error).toMatchObject({
      code: 'illegal_transition',
      current: 'completed',
      requested: 'pending',
      allowed: [],
    });
    expect((await getBattle(await testDb(), id))?.battle.status).toBe('completed');
  });

  it('accepts the legal paths: a visibility-only PATCH, and pending -> completed from the final upload', async () => {
    const owner = await makeDevice('lifecycle-owner-4', 9904);
    const id = freshBattleId();
    const finished = demoRecord({ id, demo: false });

    // the engine registers the battle as pending, then sends one final PATCH with the whole record
    const pending = withStatus(finished, 'pending');
    const created = await createBattle(
      jsonRequest('/api/v1/battles', { record: pending }, { token: owner.token }),
    );
    expect(created.status).toBe(201);

    const pendingRead = await readBattle(
      getRequest(`/api/v1/battles/${id}`, { token: owner.token }),
      params({ id }),
    );
    const pendingDetail = await jsonOf<{ record: BattleRecord; allowedNext: string[] }>(pendingRead);
    expect(pendingDetail.record.status).toBe('pending');
    expect(pendingDetail.allowedNext).toEqual([...nextBattleStatuses('pending')]);

    const uploaded = await patchBattle(
      jsonRequest(`/api/v1/battles/${id}`, { record: finished }, { method: 'PATCH', token: owner.token }),
      params({ id }),
    );
    expect(uploaded.status).toBe(200);
    const uploadedBody = await jsonOf<{ status: string; allowedNext: string[] }>(uploaded);
    expect(uploadedBody.status).toBe('completed');
    expect(uploadedBody.allowedNext).toEqual([]);

    // a visibility-only PATCH re-writes the same status: an accepted no-op for the lifecycle
    const published = await patchBattle(
      jsonRequest(
        `/api/v1/battles/${id}`,
        { visibility: 'unlisted' },
        { method: 'PATCH', token: owner.token },
      ),
      params({ id }),
    );
    expect(published.status).toBe(200);
    const publishedBody = await jsonOf<{ status: string; visibility: string; allowedNext: string[] }>(
      published,
    );
    expect(publishedBody).toMatchObject({ status: 'completed', visibility: 'unlisted', allowedNext: [] });

    // retrying the same final upload (a lost response) is accepted too
    const retried = await patchBattle(
      jsonRequest(`/api/v1/battles/${id}`, { record: finished }, { method: 'PATCH', token: owner.token }),
      params({ id }),
    );
    expect(retried.status).toBe(200);

    const read = await readBattle(getRequest(`/api/v1/battles/${id}?events=1`), params({ id }));
    expect(read.status).toBe(200);
    const detail = await jsonOf<{ record: BattleRecord; allowedNext: string[] }>(read);
    expect(detail.record.status).toBe('completed');
    expect(detail.allowedNext).toEqual([...nextBattleStatuses(detail.record.status)]);
  });
});

describe('battle lifecycle in the web UI', () => {
  it('labels every status from BATTLE_STATUS_LABELS', () => {
    for (const status of BATTLE_STATUSES) {
      const html = renderToStaticMarkup(createElement(BattleStatusBadge, { status }));
      expect(html).toContain(`>${BATTLE_STATUS_LABELS[status]}<`);
    }
  });

  it('shows the run-it card only for pending and the live view only for live statuses', async () => {
    const dbh = await testDb();
    const owner = await makeDevice('lifecycle-page-owner', 9905);
    for (const status of BATTLE_STATUSES) {
      const id = freshBattleId();
      const record = withStatus(publicRecord(demoRecord({ id, demo: false })), status);
      await upsertBattleFromRecord(dbh, { record, ownerUserId: owner.user.id, visibility: 'public' });

      const html = renderToStaticMarkup(await BattlePage({ params: Promise.resolve({ id }) }));
      expect(html, status).toContain(`>${BATTLE_STATUS_LABELS[status]}<`);
      expect(html.includes('This battle runs on your machine'), status).toBe(
        status === BATTLE_INITIAL_STATUS,
      );
      expect(html.includes('connecting to the live stream'), status).toBe(isLiveBattleStatus(status));
    }
  });
});
