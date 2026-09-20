import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Challenge } from '@harness-arena/protocol';
import { GET as listChallenges, POST as createChallenge } from '@/app/api/v1/challenges/route';
import { GET as readChallenge } from '@/app/api/v1/challenges/[id]/route';
import { POST as acceptChallenge } from '@/app/api/v1/challenges/[id]/accept/route';
import { POST as cancelChallenge } from '@/app/api/v1/challenges/[id]/cancel/route';
import { resetRateLimits } from '@/lib/api';
import { getRequest, jsonRequest, makeDevice, params } from './helpers';

function challengeRequest(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Vanilla vs agnostic-ai',
    sides: {
      a: { label: 'Vanilla', harness: { source: 'vanilla' } },
      b: { label: 'Agnostic AI', harness: { source: 'https://github.com/ucsandman/agnostic-ai' } },
    },
    agent: { id: 'fake' },
    target: {
      kind: 'task',
      task: { kind: 'prompt', prompt: 'fix the bug' },
      repository: { source: 'empty' },
    },
    ...overrides,
  };
}

describe('challenges API', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('creates, reads, accepts, lists and refuses a cancel from a non-creator', async () => {
    const creator = await makeDevice('challenge-creator', 9701);
    const acceptor = await makeDevice('challenge-acceptor', 9702);

    const created = await createChallenge(
      jsonRequest('/api/v1/challenges', challengeRequest(), { token: creator.token }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const challenge: Challenge = createdBody.challenge;
    expect(challenge.status).toBe('open');
    expect(createdBody.url).toBe(`http://localhost:3000/challenges/${challenge.id}`);
    expect(createdBody.note.length).toBeGreaterThan(0);

    const read = await readChallenge(
      getRequest(`/api/v1/challenges/${challenge.id}`),
      params({ id: challenge.id }),
    );
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.challenge.id).toBe(challenge.id);

    const accepted = await acceptChallenge(
      jsonRequest(`/api/v1/challenges/${challenge.id}/accept`, {}, { token: acceptor.token }),
      params({ id: challenge.id }),
    );
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody.challenge.status).toBe('accepted');
    expect(acceptedBody.challenge.acceptedBy.id).toBe(acceptor.user.id);

    const strangerCancel = await cancelChallenge(
      jsonRequest(`/api/v1/challenges/${challenge.id}/cancel`, {}, { token: acceptor.token }),
      params({ id: challenge.id }),
    );
    expect(strangerCancel.status).toBe(403);

    const list = await listChallenges(getRequest('/api/v1/challenges'));
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.challenges.some((entry: Challenge) => entry.id === challenge.id)).toBe(true);
  });

  it('gates a private challenge to its creator and refuses an anonymous POST', async () => {
    const creator = await makeDevice('challenge-private-creator', 9703);
    const stranger = await makeDevice('challenge-private-stranger', 9704);

    const created = await createChallenge(
      jsonRequest('/api/v1/challenges', challengeRequest({ visibility: 'private' }), {
        token: creator.token,
      }),
    );
    expect(created.status).toBe(201);
    const challenge: Challenge = (await created.json()).challenge;

    const asStranger = await readChallenge(
      getRequest(`/api/v1/challenges/${challenge.id}`, { token: stranger.token }),
      params({ id: challenge.id }),
    );
    expect(asStranger.status).toBe(404);

    const asCreator = await readChallenge(
      getRequest(`/api/v1/challenges/${challenge.id}`, { token: creator.token }),
      params({ id: challenge.id }),
    );
    expect(asCreator.status).toBe(200);

    const anonymousPost = await createChallenge(jsonRequest('/api/v1/challenges', challengeRequest(), {}));
    expect(anonymousPost.status).toBe(401);
  });
});
