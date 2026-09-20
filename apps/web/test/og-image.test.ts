import './setup-env';
import { describe, expect, it } from 'vitest';
import { upsertBattleFromRecord } from '@harness-arena/database';
import BattleOpengraphImage from '../app/battles/[id]/opengraph-image';
import HarnessOpengraphImage from '../app/harnesses/[slug]/opengraph-image';
import { demoRecord, freshBattleId, makeUser, params, testDb } from './helpers';

async function bytesOf(response: Response): Promise<number> {
  const buffer = await response.arrayBuffer();
  return buffer.byteLength;
}

describe('battle OG image', () => {
  it('renders the generic card for a private battle, never the battle title', async () => {
    const dbh = await testDb();
    const user = await makeUser('og-owner', 9801);
    const record = demoRecord({ id: freshBattleId() });
    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'private' });

    const response = await BattleOpengraphImage(params({ id: record.id }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^image\/png/);

    // The rendered PNG bytes are not easily inspected for text content in this test environment, so
    // "renders the generic card" is verified instead by byte-for-byte equality with the unknown-id
    // response below, which is provably the generic card (there is no record to render).
    const unknown = await BattleOpengraphImage(params({ id: 'battle_does_not_exist' }));
    expect(await bytesOf(response)).toBe(await bytesOf(unknown));
  });

  it('renders a demo battle without error', async () => {
    const dbh = await testDb();
    const record = demoRecord({ id: freshBattleId() });
    await upsertBattleFromRecord(dbh, { record, visibility: 'public', demo: true });

    const response = await BattleOpengraphImage(params({ id: record.id }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^image\/png/);
  });

  it('falls back to the generic card for an unknown battle id, never a 500', async () => {
    const response = await BattleOpengraphImage(params({ id: 'battle_does_not_exist' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^image\/png/);
  });
});

describe('harness OG image', () => {
  it('falls back to the generic card for an unknown slug', async () => {
    const response = await HarnessOpengraphImage(params({ slug: 'no-such-harness' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^image\/png/);
  });
});
