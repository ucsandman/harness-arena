import './setup-env';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExperimentRequestSchema } from '@harness-arena/protocol';
import {
  createExperiment,
  finalizeExperiment,
  linkBattleToExperiment,
  upsertBattleFromRecord,
} from '@harness-arena/database';
import ExperimentDetailPage from '../app/experiments/[id]/page';
import { demoRecord, freshBattleId, makeUser, testDb } from './helpers';

describe('scratch', () => {
  it('probe', async () => {
    const dbh = await testDb();
    const user = await makeUser('scratch', 9999);
    const record = demoRecord({ id: freshBattleId(), demo: false });
    const experiment = await createExperiment(
      dbh,
      createExperimentRequestSchema.parse({
        title: 'probe',
        kind: 'comparison',
        control: { harness: { source: record.runs.a.harness.source } },
        treatment: { harness: { source: record.runs.b.harness.source } },
        agent: { id: 'fake' },
        target: { kind: 'task', task: { kind: 'prompt', prompt: 'x' }, repository: { source: 'empty' } },
      }),
      { createdByUserId: user.id },
    );
    await upsertBattleFromRecord(dbh, { record, ownerUserId: user.id, visibility: 'public' });
    await linkBattleToExperiment(dbh, experiment.id, record.id, 'b');
    const f = await finalizeExperiment(dbh, experiment.id);
    const html = renderToStaticMarkup(
      await ExperimentDetailPage({ params: Promise.resolve({ id: experiment.id }) }),
    );
    writeFileSync(
      'C:/Users/sandm/AppData/Local/Temp/probe.txt',
      [
        `comparable=${f?.summary?.comparable}`,
        `battles=${f?.summary?.battles}`,
        `thin_sentence=${html.includes('is below the 5 needed for even a weak conclusion')}`,
        `panel=${html.includes('Not enough evidence to conclude anything')}`,
        `htmlLength=${html.length}`,
      ].join('\n'),
    );
    expect(true).toBe(true);
  });
});
