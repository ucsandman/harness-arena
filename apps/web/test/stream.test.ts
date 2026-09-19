import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import { insertEvents, upsertBattleFromRecord } from '@harness-arena/database';
import { GET as stream } from '@/app/api/v1/battles/[id]/stream/route';
import { resetRateLimits } from '@/lib/api';
import {
  demoEvents,
  demoRecord,
  freshBattleId,
  getRequest,
  jsonOf,
  makeUser,
  params,
  testDb,
} from './helpers';

/** Reads decoded chunks until `match` appears or the stream ends. Never waits for a poll interval. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  match: string,
  limit = 20,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < limit; i++) {
    const { value, done } = await reader.read();
    if (value) text += decoder.decode(value, { stream: true });
    if (done || text.includes(match)) break;
  }
  return text;
}

describe('battle event stream', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('streams the stored events, then closes when the client aborts', async () => {
    const dbh = await testDb();
    const user = await makeUser('stream-owner', 9401);
    const id = freshBattleId();
    // a running battle: the stream would otherwise say goodbye on its own after a terminal status
    const record = demoRecord({ id, demo: false, status: 'running', completedAt: null });
    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    const inserted = await insertEvents(dbh, id, demoEvents(id, 3));
    expect(inserted.accepted).toBe(3);

    const controller = new AbortController();
    const response = await stream(
      getRequest(`/api/v1/battles/${id}/stream`, { signal: controller.signal }),
      params({ id }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const body = response.body;
    if (!body) throw new Error('the stream has no body');
    const reader = body.getReader();

    const text = await readUntil(reader, 'event: record');
    expect(text).toContain('event: event');
    expect(text).toContain('"type":"battle.started"');
    expect(text).toContain('event: record');

    controller.abort();
    // the pump closes the controller on abort, so the reader drains and finishes
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
  });

  it('ends the stream for a finished battle and hides a private one', async () => {
    const dbh = await testDb();
    const user = await makeUser('stream-privacy', 9402);

    const publicId = freshBattleId();
    await upsertBattleFromRecord(dbh, {
      record: demoRecord({ id: publicId, demo: false }),
      ownerUserId: user.id,
      visibility: 'public',
    });
    const finished = await stream(getRequest(`/api/v1/battles/${publicId}/stream`), params({ id: publicId }));
    const body = finished.body;
    if (!body) throw new Error('the stream has no body');
    const text = await readUntil(body.getReader(), 'event: end');
    expect(text).toContain('event: end');
    expect(text).toContain('"status":"completed"');

    const privateId = freshBattleId();
    await upsertBattleFromRecord(dbh, {
      record: demoRecord({ id: privateId, demo: false }),
      ownerUserId: user.id,
      visibility: 'private',
    });
    const hidden = await stream(getRequest(`/api/v1/battles/${privateId}/stream`), params({ id: privateId }));
    expect(hidden.status).toBe(404);
    const error = await jsonOf<{ error: { code: string } }>(hidden);
    expect(error.error.code).toBe('not_found');
  });

  it('streams the event with seq 0 when the client opens the stream without ?after=', async () => {
    const dbh = await testDb();
    const user = await makeUser('stream-seq-zero', 9403);
    const id = freshBattleId();
    const record = demoRecord({ id, demo: false, status: 'running', completedAt: null });
    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    // seq 0 is a valid protocol sequence number and the ingest route accepts it
    const events = demoEvents(id, 2).map((event, index) => ({ ...event, seq: index }));
    expect((await insertEvents(dbh, id, events)).accepted).toBe(2);

    const controller = new AbortController();
    const response = await stream(
      getRequest(`/api/v1/battles/${id}/stream`, { signal: controller.signal }),
      params({ id }),
    );
    const body = response.body;
    if (!body) throw new Error('the stream has no body');
    const reader = body.getReader();

    const text = await readUntil(reader, '"seq":1');
    expect(text).toContain('"seq":0');

    controller.abort();
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
  });
});
