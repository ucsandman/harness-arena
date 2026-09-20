import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Bounty } from '@harness-arena/protocol';
import { POST as createBounty } from '@/app/api/v1/bounties/route';
import { GET as readBounty } from '@/app/api/v1/bounties/[id]/route';
import {
  GET as listSubmissions,
  POST as createSubmission,
} from '@/app/api/v1/bounties/[id]/submissions/route';
import { resetRateLimits } from '@/lib/api';
import { getRequest, jsonRequest, makeDevice, params } from './helpers';

function bountyRequest(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Beat vanilla',
    baseline: { label: 'Vanilla', harness: { source: 'vanilla' } },
    agent: { id: 'fake' },
    target: {
      kind: 'task',
      task: { kind: 'prompt', prompt: 'fix the bug' },
      repository: { source: 'empty' },
    },
    reward: { kind: 'reputation', description: 'Bragging rights' },
    ...overrides,
  };
}

describe('bounties API', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('creates a bounty, reads it, submits to it, lists submissions, and gates the write', async () => {
    const poster = await makeDevice('bounty-poster', 9721);
    const submitter = await makeDevice('bounty-submitter', 9722);

    const created = await createBounty(
      jsonRequest('/api/v1/bounties', bountyRequest(), { token: poster.token }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const bounty: Bounty = createdBody.bounty;
    expect(bounty.status).toBe('open');
    expect(createdBody.url).toBe(`http://localhost:3000/bounties/${bounty.id}`);
    expect(createdBody.note.length).toBeGreaterThan(0);

    const read = await readBounty(getRequest(`/api/v1/bounties/${bounty.id}`), params({ id: bounty.id }));
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.bounty.submissionCount).toBe(0);
    expect(readBody.submissions).toEqual([]);

    const anonymousSubmit = await createSubmission(
      jsonRequest(
        `/api/v1/bounties/${bounty.id}/submissions`,
        { harness: { harness: { source: 'vanilla' } } },
        {},
      ),
      params({ id: bounty.id }),
    );
    expect(anonymousSubmit.status).toBe(401);

    const submitted = await createSubmission(
      jsonRequest(
        `/api/v1/bounties/${bounty.id}/submissions`,
        { harness: { harness: { source: 'https://github.com/owner/challenger' } } },
        { token: submitter.token },
      ),
      params({ id: bounty.id }),
    );
    expect(submitted.status).toBe(201);
    const submittedBody = await submitted.json();
    expect(submittedBody.submission.bountyId).toBe(bounty.id);

    const list = await listSubmissions(
      getRequest(`/api/v1/bounties/${bounty.id}/submissions`),
      params({ id: bounty.id }),
    );
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.submissions).toHaveLength(1);
    expect(listBody.count).toBe(1);

    const missing = await readBounty(
      getRequest('/api/v1/bounties/bounty_doesnotexist'),
      params({ id: 'bounty_doesnotexist' }),
    );
    expect(missing.status).toBe(404);
  });
});
