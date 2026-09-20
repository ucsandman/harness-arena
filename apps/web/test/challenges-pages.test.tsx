import './setup-env';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as AuthModule from '@/lib/auth';
import type { Challenge, CreateChallengeRequest } from '@harness-arena/protocol';
import { createChallengeRequestSchema } from '@harness-arena/protocol';
import { createChallenge, listChallenges, type User } from '@harness-arena/database';
import { makeUser, testDb } from './helpers';

/** The action reads the session through getCurrentUser; there is no request scope in a unit test. */
let currentUser: User | null = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return { ...actual, getCurrentUser: async () => currentUser };
});

const { default: ChallengesPage } = await import('../app/challenges/page');
const { default: ChallengeDetailPage } = await import('../app/challenges/[id]/page');
const { createChallengeAction } = await import('../app/challenges/new/actions');
const { NEW_ARENA_INITIAL } = await import('@/lib/arena-forms');

function request(overrides: Record<string, unknown> = {}): CreateChallengeRequest {
  return createChallengeRequestSchema.parse({
    title: 'Vanilla vs agnostic-ai on the widget parser',
    sides: {
      a: { label: 'Vanilla', harness: { source: 'vanilla' } },
      b: { label: 'Agnostic AI', harness: { source: 'https://github.com/ucsandman/agnostic-ai' } },
    },
    agent: { id: 'fake' },
    target: {
      kind: 'task',
      title: 'Fix the parser',
      category: 'debugging',
      task: { kind: 'prompt', prompt: 'fix the bug' },
      repository: { source: 'empty' },
    },
    ...overrides,
  });
}

async function seed(overrides: Record<string, unknown> = {}): Promise<Challenge> {
  const dbh = await testDb();
  const user = await makeUser('challenge-page-creator', 9811);
  return createChallenge(dbh, request(overrides), { createdByUserId: user.id });
}

describe('/challenges', () => {
  it('lists open challenges with both sides, the agent and the honesty note', async () => {
    const challenge = await seed();

    const html = renderToStaticMarkup(await ChallengesPage());
    expect(html).toContain(challenge.title);
    expect(html).toContain('Vanilla');
    expect(html).toContain('Agnostic AI');
    expect(html).toContain('agent fake');
    expect(html).toContain('rating eligible');
    expect(html).toContain('Arena hosts no runner');
    expect(html).toContain('0 linked battle(s)');
  });
});

describe('/challenges/[id]', () => {
  it('shows the definition, the exact run command and an empty linked-battle state', async () => {
    const challenge = await seed();

    const html = renderToStaticMarkup(
      await ChallengeDetailPage({ params: Promise.resolve({ id: challenge.id }) }),
    );
    expect(html).toContain(challenge.id);
    expect(html).toContain(`arena challenge run ${challenge.id}`);
    expect(html).toContain('Arena hosts no runner');
    expect(html).toContain('No battle has been linked yet');
    // only two timestamps exist, so the acceptance step reports who, not a borrowed date
    expect(html).toContain('nobody has taken it on yet');
  });
});

describe('createChallengeAction', () => {
  it('stores the challenge for a signed-in user and redirects to its page', async () => {
    const dbh = await testDb();
    currentUser = await makeUser('challenge-action-user', 9812);

    const form = new FormData();
    form.set('title', 'Action-created challenge');
    form.set('aSource', 'vanilla');
    form.set('bSource', 'https://github.com/ucsandman/agnostic-ai');
    form.set('bCommit', 'c0ffee1');
    form.set('agent', 'fake');
    form.set('targetKind', 'task');
    form.set('taskTitle', 'Fix the parser');
    form.set('category', 'debugging');
    form.set('prompt', 'fix the bug');
    form.set('repositorySource', 'empty');
    form.set('testsCommand', 'npm test');
    form.set('upload', 'metrics');
    form.set('visibility', 'public');
    form.set('ratingEligible', 'on');

    let digest = '';
    try {
      await createChallengeAction(NEW_ARENA_INITIAL, form);
      throw new Error('the action returned instead of redirecting');
    } catch (error) {
      digest = (error as { digest?: string }).digest ?? '';
    }
    expect(digest).toContain('/challenges/chl_');

    const stored = await listChallenges(dbh, { limit: 50 });
    const created = stored.find((entry) => entry.title === 'Action-created challenge');
    expect(created).toBeDefined();
    expect(created?.sides.a.harness.source).toBe('vanilla');
    expect(created?.sides.b.harness.commit).toBe('c0ffee1');
    expect(created?.agent.id).toBe('fake');
    expect(created?.ratingEligible).toBe(true);
    expect(created?.target.kind).toBe('task');
    expect(digest).toContain(created?.id ?? 'no-id');
  });

  it('refuses an invalid form and a signed-out caller without touching the database', async () => {
    const dbh = await testDb();
    currentUser = await makeUser('challenge-action-user-2', 9813);

    const before = (await listChallenges(dbh, { limit: 100 })).length;

    const empty = new FormData();
    empty.set('targetKind', 'task');
    const invalid = await createChallengeAction(NEW_ARENA_INITIAL, empty);
    expect(invalid.status).toBe('error');
    expect(invalid.errors.length).toBeGreaterThan(0);

    currentUser = null;
    const signedOut = await createChallengeAction(NEW_ARENA_INITIAL, new FormData());
    expect(signedOut.status).toBe('error');
    expect(signedOut.errors[0]).toContain('session expired');

    expect((await listChallenges(dbh, { limit: 100 })).length).toBe(before);
  });
});
