import './setup-env';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExperimentRequestSchema, harnessManifestSchema } from '@harness-arena/protocol';
import {
  createExperiment,
  finalizeExperiment,
  getHarnessProfile,
  upsertBattleFromRecord,
  upsertComponentsFromManifest,
} from '@harness-arena/database';
import ComponentsPage from '../app/components/page';
import ComponentDetailPage from '../app/components/[...slug]/page';
import { demoRecord, freshBattleId, makeUser, testDb } from './helpers';

const MANIFEST = harnessManifestSchema.parse({
  arena: 1,
  name: 'agnostic-ai',
  components: [
    {
      kind: 'skill',
      name: 'code-review',
      path: '.claude/skills/code-review',
      description: 'A review pass before the final answer.',
      source: 'https://github.com/ucsandman/agnostic-ai',
    },
  ],
});

/** A battle upload is what creates the harness version a component can hang off. */
async function seedComponent(login: string, githubId: number): Promise<string> {
  const dbh = await testDb();
  const user = await makeUser(login, githubId);
  const record = demoRecord({ id: freshBattleId(), demo: false });
  await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });

  const profile = await getHarnessProfile(dbh, 'ucsandman--agnostic-ai');
  const versionId = profile?.versions[0]?.id;
  if (!versionId) throw new Error('the demo battle did not create a harness version');
  const written = await upsertComponentsFromManifest(dbh, versionId, MANIFEST);
  expect(written).toBe(1);
  return user.id;
}

describe('/components', () => {
  it('lists a declared component and says plainly that nobody has measured it', async () => {
    await seedComponent('component-owner', 9851);

    const html = renderToStaticMarkup(
      await ComponentsPage({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain('code-review');
    expect(html).toContain('Skill');
    expect(html).toContain('1 harness(es)');
    expect(html).toContain('0 experiment(s)');
    expect(html).toContain('No experiment evidence yet.');
    expect(html).not.toContain('0.0 pts');

    const filtered = renderToStaticMarkup(
      await ComponentsPage({ searchParams: Promise.resolve({ kind: 'hook' }) }),
    );
    expect(filtered).not.toContain('code-review');
    expect(filtered).toContain('No Hook component yet');
  });
});

describe('/components/[...slug]', () => {
  it('shows the harness versions declaring it and the experiments that changed it', async () => {
    const userId = await seedComponent('component-owner-2', 9852);
    const dbh = await testDb();

    const experiment = await createExperiment(
      dbh,
      createExperimentRequestSchema.parse({
        title: 'Ablating the review skill',
        kind: 'ablation',
        control: { harness: { source: 'vanilla' } },
        treatment: { harness: { source: 'https://github.com/ucsandman/agnostic-ai' } },
        changedComponent: { kind: 'skill', name: 'code-review' },
        agent: { id: 'fake' },
        target: {
          kind: 'task',
          task: { kind: 'prompt', prompt: 'fix the bug' },
          repository: { source: 'empty' },
        },
      }),
      { createdByUserId: userId },
    );
    await finalizeExperiment(dbh, experiment.id);

    const html = renderToStaticMarkup(
      await ComponentDetailPage({ params: Promise.resolve({ slug: ['skill', 'code-review'] }) }),
    );

    expect(html).toContain('code-review');
    expect(html).toContain('A review pass before the final answer.');
    expect(html).toContain('ucsandman--agnostic-ai');
    expect(html).toContain('.claude/skills/code-review');
    expect(html).toContain('Ablating the review skill');
    expect(html).toContain(experiment.id);
    // the experiment finished with no linked battles, so there is no delta to show and none is invented
    expect(html).toContain('not measured');
    expect(html).toContain('mean over n=1 completed experiment(s)');
  });
});
