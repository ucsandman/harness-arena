import './setup-env';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExperimentRequestSchema } from '@harness-arena/protocol';
import {
  createExperiment,
  finalizeExperiment,
  linkBattleToExperiment,
  upsertBattleFromRecord,
} from '@harness-arena/database';
import ExperimentsPage from '../app/experiments/page';
import ExperimentDetailPage from '../app/experiments/[id]/page';
import { demoRecord, freshBattleId, makeUser, testDb } from './helpers';

function experimentRequest(overrides: Record<string, unknown> = {}) {
  return createExperimentRequestSchema.parse({
    title: 'Does the review skill help?',
    kind: 'ablation',
    control: { label: 'without the skill', harness: { source: 'vanilla' } },
    treatment: {
      label: 'with the skill',
      harness: { source: 'https://github.com/ucsandman/agnostic-ai' },
    },
    changedComponent: { kind: 'skill', name: 'code-review' },
    agent: { id: 'fake' },
    target: {
      kind: 'task',
      title: 'Fix the parser',
      category: 'debugging',
      task: { kind: 'prompt', prompt: 'fix the bug' },
      repository: { source: 'empty' },
    },
    trials: 3,
    ...overrides,
  });
}

describe('/experiments', () => {
  it('lists an experiment with no summary as exactly that, never as a zero result', async () => {
    const dbh = await testDb();
    const user = await makeUser('experiment-author', 9821);
    const experiment = await createExperiment(dbh, experimentRequest(), { createdByUserId: user.id });

    const html = renderToStaticMarkup(await ExperimentsPage());
    expect(html).toContain(experiment.title);
    expect(html).toContain('ablation');
    expect(html).toContain('code-review');
    expect(html).toContain('no summary yet');
    expect(html).toContain('3 trial(s) per task');
    expect(html).toContain('0 battle(s)');
  });
});

describe('/experiments/[id]', () => {
  it('states that there is not enough evidence, and prints the command that reproduces it', async () => {
    const dbh = await testDb();
    const user = await makeUser('experiment-author-2', 9822);
    const experiment = await createExperiment(dbh, experimentRequest(), { createdByUserId: user.id });

    const html = renderToStaticMarkup(
      await ExperimentDetailPage({ params: Promise.resolve({ id: experiment.id }) }),
    );
    expect(html).toContain('Not enough evidence to conclude anything');
    expect(html).toContain('still running, or no battle has been linked');
    expect(html).toContain('arena experiment run');
    expect(html).toContain('--kind ablation');
    expect(html).toContain('--component skill:code-review');
    expect(html).toContain('--trials 3');
    expect(html).toContain('No battle is linked yet');
  });

  it('renders the summary from one linked battle and keeps the sample beside every number', async () => {
    const dbh = await testDb();
    const user = await makeUser('experiment-author-3', 9823);
    const record = demoRecord({ id: freshBattleId(), demo: false });

    // the experiment must name the harnesses the battle actually ran, or the link is refused
    const experiment = await createExperiment(
      dbh,
      experimentRequest({
        title: 'One battle is an anecdote',
        kind: 'comparison',
        control: { harness: { source: record.runs.a.harness.source } },
        treatment: { harness: { source: record.runs.b.harness.source } },
        changedComponent: undefined,
        trials: 1,
      }),
      { createdByUserId: user.id },
    );

    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    await linkBattleToExperiment(dbh, experiment.id, record.id, 'b');
    const finalized = await finalizeExperiment(dbh, experiment.id);
    expect(finalized?.summary?.battles).toBe(1);

    const html = renderToStaticMarkup(
      await ExperimentDetailPage({ params: Promise.resolve({ id: experiment.id }) }),
    );
    expect(html).toContain('control wins');
    expect(html).toContain('treatment wins');
    expect(html).toContain('1 battle(s) reached a verdict');
    // one battle is below the minimum for even a weak conclusion, and the page says so with the count
    expect(html).toContain('is below the 5 needed for even a weak conclusion');
    expect(html).toContain('evidence: none');
    expect(html).toContain(record.id);
    expect(html).not.toContain('No battle is linked yet');
  });
});
