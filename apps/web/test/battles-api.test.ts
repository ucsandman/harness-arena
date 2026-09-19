import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BATTLE_SPEC_VERSION,
  type ArenaEvent,
  type BattleListItem,
  type BattleRecord,
} from '@harness-arena/protocol';
import { getBattle, getLeaderboard, insertEvents, type LeaderboardRow } from '@harness-arena/database';
import { GET as listMine, POST as createBattle } from '@/app/api/v1/battles/route';
import { GET as readBattle, PATCH as patchBattle } from '@/app/api/v1/battles/[id]/route';
import { resetRateLimits } from '@/lib/api';
import {
  demoEvents,
  demoRecord,
  freshBattleId,
  getRequest,
  jsonOf,
  jsonRequest,
  makeDevice,
  params,
  testDb,
} from './helpers';

describe('battles API', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('accepts the exported demo record and enforces visibility on reads', async () => {
    const owner = await makeDevice('battle-owner', 9201);
    const id = freshBattleId();
    const record = demoRecord({ id, demo: false });

    const created = await createBattle(jsonRequest('/api/v1/battles', { record }, { token: owner.token }));
    expect(created.status).toBe(201);
    const links = await jsonOf<{ id: string; url: string; streamUrl: string }>(created);
    expect(links.id).toBe(id);
    expect(links.url).toBe(`http://localhost:3000/battles/${id}`);
    expect(links.streamUrl).toBe(`http://localhost:3000/api/v1/battles/${id}/stream`);

    // the spec says private, so an anonymous reader must not see it
    const anonymous = await readBattle(getRequest(`/api/v1/battles/${id}`), params({ id }));
    expect(anonymous.status).toBe(404);

    // the owner's device can
    const asOwner = await readBattle(
      getRequest(`/api/v1/battles/${id}`, { token: owner.token }),
      params({ id }),
    );
    expect(asOwner.status).toBe(200);
    const body = await jsonOf<{ record: BattleRecord; eventCount: number }>(asOwner);
    expect(body.record.task.title).toBe('Fix the session-expiry bug');
    expect(body.eventCount).toBe(0);

    // another account's device cannot read it and cannot overwrite it
    const stranger = await makeDevice('battle-stranger', 9202);
    const asStranger = await readBattle(
      getRequest(`/api/v1/battles/${id}`, { token: stranger.token }),
      params({ id }),
    );
    expect(asStranger.status).toBe(404);
    const hijack = await createBattle(jsonRequest('/api/v1/battles', { record }, { token: stranger.token }));
    expect(hijack.status).toBe(403);

    // publishing it makes it readable by anyone, and downloadable as battle.json
    const patched = await patchBattle(
      jsonRequest(`/api/v1/battles/${id}`, { visibility: 'public' }, { method: 'PATCH', token: owner.token }),
      params({ id }),
    );
    expect(patched.status).toBe(200);

    const nowPublic = await readBattle(getRequest(`/api/v1/battles/${id}`), params({ id }));
    expect(nowPublic.status).toBe(200);

    const download = await readBattle(getRequest(`/api/v1/battles/${id}?format=json`), params({ id }));
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${id}.json"`);
    const downloaded = await jsonOf<BattleRecord>(download);
    expect(downloaded.id).toBe(id);

    // and it shows up in the caller's own list
    const mine = await listMine(getRequest('/api/v1/battles', { token: owner.token }));
    expect(mine.status).toBe(200);
    const list = await jsonOf<{ battles: BattleListItem[]; count: number }>(mine);
    expect(list.battles.some((item) => item.id === id)).toBe(true);
  });

  it('creates a pending battle from a spec alone', async () => {
    const owner = await makeDevice('spec-owner', 9203);
    const spec = {
      version: BATTLE_SPEC_VERSION,
      title: 'Spec only battle',
      task: { kind: 'prompt', prompt: 'Add a failing test and then fix it.' },
      repository: { source: 'https://github.com/owner/repo', ref: 'main' },
      competitors: {
        a: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
        b: { agent: { id: 'fake' }, harness: { source: 'https://github.com/owner/harness' } },
      },
    };

    const created = await createBattle(jsonRequest('/api/v1/battles', { spec }, { token: owner.token }));
    expect(created.status).toBe(201);
    const links = await jsonOf<{ id: string }>(created);

    const read = await readBattle(
      getRequest(`/api/v1/battles/${links.id}`, { token: owner.token }),
      params({ id: links.id }),
    );
    const body = await jsonOf<{ record: BattleRecord }>(read);
    expect(body.record.status).toBe('pending');
    expect(body.record.runs.a.status).toBe('pending');
    expect(body.record.runs.b.harness.kind).toBe('github');
    expect(body.record.runs.b.harness.name).toBe('owner/harness');
    expect(body.record.repository.kind).toBe('github');
    expect(body.record.verification).toEqual({ kind: 'local', eligible: false, sandbox: null });
    expect(body.record.runs.a.metrics.cost_usd).toEqual({ value: null, status: 'unavailable' });
  });

  it('rejects an empty body, an unknown battle and a mismatched record id', async () => {
    const owner = await makeDevice('battle-validator', 9204);

    const empty = await createBattle(jsonRequest('/api/v1/battles', {}, { token: owner.token }));
    expect(empty.status).toBe(400);

    const missing = await readBattle(
      getRequest('/api/v1/battles/btl_doesnotexist000', { token: owner.token }),
      params({ id: 'btl_doesnotexist000' }),
    );
    expect(missing.status).toBe(404);
    const body = await jsonOf<{ error: { code: string } }>(missing);
    expect(body.error.code).toBe('not_found');

    const id = freshBattleId();
    await createBattle(
      jsonRequest('/api/v1/battles', { record: demoRecord({ id }) }, { token: owner.token }),
    );
    const mismatched = await patchBattle(
      jsonRequest(
        `/api/v1/battles/${id}`,
        { record: demoRecord({ id: freshBattleId() }) },
        { method: 'PATCH', token: owner.token },
      ),
      params({ id }),
    );
    expect(mismatched.status).toBe(400);
  });

  it('stores an upload as self-reported, and rates it only once it is public', async () => {
    const owner = await makeDevice('pool-claimer', 9205);
    const dbh = await testDb();
    const id = freshBattleId();
    // an upload claiming Arena-executed provenance, with a decided verdict and a private spec
    const record = demoRecord({
      id,
      demo: false,
      verification: { kind: 'cloud', eligible: true, sandbox: 'arena-cloud-1' },
    });
    expect(record.spec.visibility).toBe('private');
    expect(record.verdict?.winner).toBe('tie');

    const totalBattles = (rows: LeaderboardRow[]): number => rows.reduce((sum, row) => sum + row.battles, 0);
    const before = await getLeaderboard(dbh, { category: 'overall', pool: 'community' });

    const created = await createBattle(jsonRequest('/api/v1/battles', { record }, { token: owner.token }));
    expect(created.status).toBe(201);

    // the server decides provenance, never the payload
    const stored = await getBattle(dbh, id);
    expect(stored?.battle.record.verification).toEqual({ kind: 'local', eligible: false, sandbox: null });
    expect(await getLeaderboard(dbh, { category: 'overall', pool: 'verified' })).toEqual([]);

    // private: the community pool did not move either
    expect(await getLeaderboard(dbh, { category: 'overall', pool: 'community' })).toEqual(before);

    // publishing it is what counts it: both competitors gain one battle
    const published = await patchBattle(
      jsonRequest(`/api/v1/battles/${id}`, { visibility: 'public' }, { method: 'PATCH', token: owner.token }),
      params({ id }),
    );
    expect(published.status).toBe(200);
    const after = await getLeaderboard(dbh, { category: 'overall', pool: 'community' });
    expect(after).toHaveLength(2);
    expect(totalBattles(after)).toBe(totalBattles(before) + 2);
    expect(await getLeaderboard(dbh, { category: 'overall', pool: 'verified' })).toEqual([]);
  });

  it('returns the event with seq 0 when ?events=1 is read without ?after=', async () => {
    const owner = await makeDevice('events-reader', 9206);
    const dbh = await testDb();
    const id = freshBattleId();
    await createBattle(
      jsonRequest('/api/v1/battles', { record: demoRecord({ id, demo: false }) }, { token: owner.token }),
    );
    const events = demoEvents(id, 2).map((event, index) => ({ ...event, seq: index }));
    expect((await insertEvents(dbh, id, events)).accepted).toBe(2);

    const read = await readBattle(
      getRequest(`/api/v1/battles/${id}?events=1`, { token: owner.token }),
      params({ id }),
    );
    expect(read.status).toBe(200);
    const body = await jsonOf<{ events: ArenaEvent[] }>(read);
    expect(body.events.map((event) => event.seq)).toEqual([0, 1]);
  });
});
