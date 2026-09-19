import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import { POST as createBattle } from '@/app/api/v1/battles/route';
import { POST as ingest } from '@/app/api/v1/battles/[id]/events/route';
import { POST as uploadArtifact } from '@/app/api/v1/battles/[id]/artifacts/route';
import { GET as readBattle } from '@/app/api/v1/battles/[id]/route';
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
} from './helpers';

interface IngestResponse {
  accepted: number;
  rejected: number;
  lastSeq: number | null;
  capped: boolean;
}

describe('event ingestion', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('accepts a batch, deduplicates a retry, and refuses foreign events', async () => {
    const owner = await makeDevice('ingest-owner', 9301);
    const id = freshBattleId();
    await createBattle(
      jsonRequest('/api/v1/battles', { record: demoRecord({ id, demo: false }) }, { token: owner.token }),
    );
    const events = demoEvents(id, 5);
    expect(events).toHaveLength(5);

    const first = await ingest(
      jsonRequest(`/api/v1/battles/${id}/events`, { events }, { token: owner.token }),
      params({ id }),
    );
    expect(first.status).toBe(200);
    const firstBody = await jsonOf<IngestResponse>(first);
    expect(firstBody.accepted).toBe(5);
    expect(firstBody.rejected).toBe(0);
    expect(firstBody.capped).toBe(false);
    expect(firstBody.lastSeq).toBe(events[4]?.seq);

    // the same batch again: the (battle, seq) primary key makes it a no-op, counted as rejected
    const retry = await ingest(
      jsonRequest(`/api/v1/battles/${id}/events`, { events }, { token: owner.token }),
      params({ id }),
    );
    const retryBody = await jsonOf<IngestResponse>(retry);
    expect(retryBody.accepted).toBe(0);
    expect(retryBody.rejected).toBe(5);

    // events belonging to another battle are refused outright
    const foreign = await ingest(
      jsonRequest(
        `/api/v1/battles/${id}/events`,
        { events: demoEvents(freshBattleId(), 2) },
        { token: owner.token },
      ),
      params({ id }),
    );
    expect(foreign.status).toBe(400);

    // and the stored events come back on the read path
    const read = await readBattle(
      getRequest(`/api/v1/battles/${id}?events=1`, { token: owner.token }),
      params({ id }),
    );
    const body = await jsonOf<{ events: unknown[]; eventCount: number }>(read);
    expect(body.eventCount).toBe(5);
    expect(body.events).toHaveLength(5);
  });

  it('rejects an invalid event and a batch from another account', async () => {
    const owner = await makeDevice('ingest-validator', 9302);
    const stranger = await makeDevice('ingest-stranger', 9303);
    const id = freshBattleId();
    await createBattle(
      jsonRequest('/api/v1/battles', { record: demoRecord({ id, demo: false }) }, { token: owner.token }),
    );

    const invalid = await ingest(
      jsonRequest(
        `/api/v1/battles/${id}/events`,
        { events: [{ v: 1, type: 'not.a.real.event', battleId: id }] },
        { token: owner.token },
      ),
      params({ id }),
    );
    expect(invalid.status).toBe(400);
    const body = await jsonOf<{ error: { code: string } }>(invalid);
    expect(body.error.code).toBe('invalid_request');

    const notOwner = await ingest(
      jsonRequest(`/api/v1/battles/${id}/events`, { events: demoEvents(id, 1) }, { token: stranger.token }),
      params({ id }),
    );
    expect(notOwner.status).toBe(403);
  });

  it('stores an artifact for the owner only', async () => {
    const owner = await makeDevice('artifact-owner', 9304);
    const stranger = await makeDevice('artifact-stranger', 9305);
    const id = freshBattleId();
    await createBattle(
      jsonRequest('/api/v1/battles', { record: demoRecord({ id, demo: false }) }, { token: owner.token }),
    );

    const stored = await uploadArtifact(
      jsonRequest(
        `/api/v1/battles/${id}/artifacts`,
        { side: 'a', kind: 'diff', content: 'diff --git a/x b/x\n', contentType: 'text/x-diff' },
        { token: owner.token },
      ),
      params({ id }),
    );
    expect(stored.status).toBe(201);
    const body = await jsonOf<{ kind: string; side: string; bytes: number }>(stored);
    expect(body.kind).toBe('diff');
    expect(body.bytes).toBe(Buffer.byteLength('diff --git a/x b/x\n', 'utf8'));

    const refused = await uploadArtifact(
      jsonRequest(
        `/api/v1/battles/${id}/artifacts`,
        { side: 'b', kind: 'diff', content: 'nope' },
        { token: stranger.token },
      ),
      params({ id }),
    );
    expect(refused.status).toBe(403);
  });
});
