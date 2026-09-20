import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChallengeRequestSchema } from '@harness-arena/protocol';
import type { ArenaDb } from '../src/client.js';
import {
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  expireChallenges,
  getChallenge,
  listChallenges,
} from '../src/challenges.js';
import { battleLinks } from '../src/schema/index.js';
import { upsertBattleFromRecord, upsertGithubUser } from '../src/queries.js';
import { buildRecord, freshDb } from './helpers.js';

describe('challenges', () => {
  let handle: ArenaDb;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  const target = {
    kind: 'task' as const,
    task: { kind: 'prompt' as const, prompt: 'Fix the failing parser test' },
    repository: { source: 'https://github.com/acme/widget' },
  };

  function req(overrides: Record<string, unknown> = {}) {
    return createChallengeRequestSchema.parse({
      title: 'A vs B',
      sides: {
        a: { harness: { source: 'vanilla' } },
        b: { harness: { source: 'https://github.com/acme/challenger' } },
      },
      agent: { id: 'claude-code' },
      target,
      ...overrides,
    });
  }

  it('creates, gets, and enforces private visibility', async () => {
    const creator = await upsertGithubUser(handle.db, { githubId: 1, login: 'creator' });
    const stranger = await upsertGithubUser(handle.db, { githubId: 2, login: 'stranger' });

    const created = await createChallenge(handle.db, req({ visibility: 'private' }), {
      createdByUserId: creator.id,
    });
    expect(created.status).toBe('open');
    expect(created.visibility).toBe('private');

    expect(await getChallenge(handle.db, created.id, null)).toBeNull();
    expect(await getChallenge(handle.db, created.id, stranger.id)).toBeNull();
    expect(await getChallenge(handle.db, created.id, creator.id)).not.toBeNull();

    const accepted = await acceptChallenge(handle.db, created.id, stranger.id);
    expect(accepted.ok).toBe(true);

    expect(await getChallenge(handle.db, created.id, stranger.id)).not.toBeNull();

    const otherStranger = await upsertGithubUser(handle.db, { githubId: 3, login: 'other-stranger' });
    expect(await getChallenge(handle.db, created.id, otherStranger.id)).toBeNull();
  });

  it('lists public challenges filtered by status and harness slug', async () => {
    const creator = await upsertGithubUser(handle.db, { githubId: 10, login: 'lister' });
    await upsertBattleFromRecord(handle.db, {
      record: buildRecord({
        harnessA: {
          name: 'x',
          source: 'https://github.com/acme/challenger',
          kind: 'github',
          commit: 'abc1234',
        },
      }),
    });

    const pub = await createChallenge(handle.db, req({ visibility: 'public' }), {
      createdByUserId: creator.id,
    });
    await createChallenge(handle.db, req({ visibility: 'private' }), { createdByUserId: creator.id });

    const all = await listChallenges(handle.db);
    expect(all.map((c) => c.id)).toEqual([pub.id]);

    const openOnly = await listChallenges(handle.db, { status: 'open' });
    expect(openOnly.map((c) => c.id)).toEqual([pub.id]);
    const acceptedOnly = await listChallenges(handle.db, { status: 'accepted' });
    expect(acceptedOnly).toHaveLength(0);

    const bySlug = await listChallenges(handle.db, { harnessSlug: 'acme--challenger' });
    expect(bySlug.map((c) => c.id)).toEqual([pub.id]);

    const unknownSlug = await listChallenges(handle.db, { harnessSlug: 'nope--nope' });
    expect(unknownSlug).toEqual([]);
  });

  it('accept: open to accepted, creator may accept their own, and a second acceptor is refused', async () => {
    const creator = await upsertGithubUser(handle.db, { githubId: 20, login: 'c2' });
    const other = await upsertGithubUser(handle.db, { githubId: 21, login: 'o2' });
    const challenge = await createChallenge(handle.db, req(), { createdByUserId: creator.id });

    const bySelf = await acceptChallenge(handle.db, challenge.id, creator.id);
    expect(bySelf.ok).toBe(true);
    if (bySelf.ok) expect(bySelf.challenge.status).toBe('accepted');

    const again = await acceptChallenge(handle.db, challenge.id, other.id);
    expect(again).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('cancel: only the creator can cancel', async () => {
    const creator = await upsertGithubUser(handle.db, { githubId: 30, login: 'c3' });
    const stranger = await upsertGithubUser(handle.db, { githubId: 31, login: 's3' });
    const challenge = await createChallenge(handle.db, req(), { createdByUserId: creator.id });

    const denied = await cancelChallenge(handle.db, challenge.id, stranger.id);
    expect(denied).toMatchObject({ ok: false, code: 'forbidden' });

    const cancelled = await cancelChallenge(handle.db, challenge.id, creator.id);
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.challenge.status).toBe('cancelled');
  });

  it('expireChallenges moves only past-deadline open or accepted challenges, and returns the count', async () => {
    const creator = await upsertGithubUser(handle.db, { githubId: 40, login: 'c4' });
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    const expiredOpen = await createChallenge(handle.db, req({ expiresAt: past }), {
      createdByUserId: creator.id,
    });
    const notYet = await createChallenge(handle.db, req({ expiresAt: future }), {
      createdByUserId: creator.id,
    });
    const noDeadline = await createChallenge(handle.db, req(), { createdByUserId: creator.id });

    const acceptedExpired = await createChallenge(handle.db, req({ expiresAt: past }), {
      createdByUserId: creator.id,
    });
    await acceptChallenge(handle.db, acceptedExpired.id, creator.id);

    const cancelledExpired = await createChallenge(handle.db, req({ expiresAt: past }), {
      createdByUserId: creator.id,
    });
    await cancelChallenge(handle.db, cancelledExpired.id, creator.id);

    const count = await expireChallenges(handle.db, new Date());
    expect(count).toBe(2);

    expect((await getChallenge(handle.db, expiredOpen.id, creator.id))?.status).toBe('expired');
    expect((await getChallenge(handle.db, acceptedExpired.id, creator.id))?.status).toBe('expired');
    expect((await getChallenge(handle.db, notYet.id, creator.id))?.status).toBe('open');
    expect((await getChallenge(handle.db, noDeadline.id, creator.id))?.status).toBe('open');
    expect((await getChallenge(handle.db, cancelledExpired.id, creator.id))?.status).toBe('cancelled');
  });

  it('battleIds are read from battle_links', async () => {
    const creator = await upsertGithubUser(handle.db, { githubId: 50, login: 'c5' });
    const challenge = await createChallenge(handle.db, req(), { createdByUserId: creator.id });
    const battle = buildRecord({
      harnessB: {
        name: 'challenger',
        source: 'https://github.com/acme/challenger',
        kind: 'github',
        commit: 'abc1234',
      },
    });
    await upsertBattleFromRecord(handle.db, { record: battle });
    await handle.db
      .insert(battleLinks)
      .values({ battleId: battle.id, kind: 'challenge', targetId: challenge.id });

    const fetched = await getChallenge(handle.db, challenge.id, creator.id);
    expect(fetched?.battleIds).toEqual([battle.id]);
  });
});
