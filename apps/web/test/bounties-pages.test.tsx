import './setup-env';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBountyRequestSchema } from '@harness-arena/protocol';
import { createBounty } from '@harness-arena/database';
import BountiesPage from '../app/bounties/page';
import BountyDetailPage from '../app/bounties/[id]/page';
import { makeUser, testDb } from './helpers';

function bountyRequest(overrides: Record<string, unknown> = {}) {
  return createBountyRequestSchema.parse({
    title: 'Beat vanilla on the parser suite',
    description: 'Fewer tokens, same correctness.',
    baseline: { label: 'Vanilla', harness: { source: 'vanilla' } },
    agent: { id: 'fake' },
    target: {
      kind: 'task',
      title: 'Fix the parser',
      category: 'debugging',
      task: { kind: 'prompt', prompt: 'fix the bug' },
      repository: { source: 'empty' },
    },
    condition: { mustWin: 'every', minBattles: 3, maxTokensRatio: 0.8 },
    reward: { kind: 'reputation', description: 'A post naming the winner.' },
    eligibility: 'Any public harness.',
    ...overrides,
  });
}

describe('/bounties', () => {
  it('lists open bounties with their condition and says Arena moves no money', async () => {
    const dbh = await testDb();
    const user = await makeUser('bounty-author', 9841);
    const bounty = await createBounty(dbh, bountyRequest(), { createdByUserId: user.id });

    const html = renderToStaticMarkup(await BountiesPage());
    expect(html).toContain(bounty.title);
    expect(html).toContain('must win every');
    expect(html).toContain('at least 3 battle(s)');
    expect(html).toContain('tokens &lt;= 0.8 x baseline');
    expect(html).toContain('Arena moves no money');
    expect(html).toContain('0 submission(s)');
  });
});

describe('/bounties/[id]', () => {
  it('renders the condition as a checklist with its numbers and the two-step submission flow', async () => {
    const dbh = await testDb();
    const user = await makeUser('bounty-author-2', 9842);
    const bounty = await createBounty(dbh, bountyRequest(), { createdByUserId: user.id });

    const html = renderToStaticMarkup(
      await BountyDetailPage({ params: Promise.resolve({ id: bounty.id }) }),
    );

    expect(html).toContain('The submission won EVERY battle linked to it.');
    expect(html).toContain('At least 3 battle(s) are linked to the submission.');
    expect(html).toContain('at most 0.8 on every battle that reported both sides');
    expect(html).not.toContain('Cost: submission / baseline');
    expect(html).toContain('Missing evidence is never a pass');

    // there is no `arena bounty` command yet, so the page states the API step it actually takes
    expect(html).toContain('/api/v1/bounties/' + bounty.id + '/submissions');
    expect(html).toContain('arena run submission.json --upload metrics --visibility public');
    expect(html).toContain('arena.bountySubmissionId');

    expect(html).toContain('Reputation only');
    expect(html).toContain('Any public harness.');
    expect(html).toContain('Nobody has entered yet');
    expect(html).toContain('no deadline');
  });
});
