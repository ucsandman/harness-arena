import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Experiment } from '@harness-arena/protocol';
import { GET as listExperiments, POST as createExperiment } from '@/app/api/v1/experiments/route';
import { GET as readExperiment } from '@/app/api/v1/experiments/[id]/route';
import { POST as linkBattle } from '@/app/api/v1/experiments/[id]/battles/route';
import { POST as finalizeExperiment } from '@/app/api/v1/experiments/[id]/finalize/route';
import { POST as createBattle } from '@/app/api/v1/battles/route';
import { resetRateLimits } from '@/lib/api';
import { demoRecord, freshBattleId, getRequest, jsonRequest, makeDevice, params } from './helpers';

/**
 * Control = vanilla, treatment = the agnostic-ai harness: the same sources the exported demo record
 * carries on its runs (run a = agnostic-ai, run b = vanilla), so a battle built from that record links
 * with treatmentSide "a" without any override.
 */
function comparisonRequest(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Agnostic AI vs vanilla',
    kind: 'comparison',
    control: { label: 'Vanilla', harness: { source: 'vanilla' } },
    treatment: { label: 'Agnostic AI', harness: { source: 'https://github.com/ucsandman/agnostic-ai' } },
    agent: { id: 'fake' },
    target: {
      kind: 'task',
      task: { kind: 'prompt', prompt: 'fix the bug' },
      repository: { source: 'empty' },
    },
    ...overrides,
  };
}

describe('experiments API', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('creates, reads, lists, links a battle and finalizes an experiment', async () => {
    const owner = await makeDevice('experiment-owner', 9401);

    const created = await createExperiment(
      jsonRequest('/api/v1/experiments', comparisonRequest(), { token: owner.token }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const experiment: Experiment = createdBody.experiment;
    expect(experiment.kind).toBe('comparison');
    expect(experiment.status).toBe('running');
    expect(createdBody.url).toBe(`http://localhost:3000/experiments/${experiment.id}`);

    const read = await readExperiment(
      getRequest(`/api/v1/experiments/${experiment.id}`),
      params({ id: experiment.id }),
    );
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.experiment.id).toBe(experiment.id);

    const list = await listExperiments(getRequest('/api/v1/experiments'));
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.experiments.some((entry: Experiment) => entry.id === experiment.id)).toBe(true);

    const battleId = freshBattleId();
    const battleCreated = await createBattle(
      jsonRequest('/api/v1/battles', { record: demoRecord({ id: battleId }) }, { token: owner.token }),
    );
    expect(battleCreated.status).toBe(201);

    const linked = await linkBattle(
      jsonRequest(
        `/api/v1/experiments/${experiment.id}/battles`,
        { battleId, treatmentSide: 'a' },
        { token: owner.token },
      ),
      params({ id: experiment.id }),
    );
    expect(linked.status).toBe(200);
    const linkedBody = await linked.json();
    expect(linkedBody).toEqual({ battleId, treatmentSide: 'a', experimentId: experiment.id });

    const finalized = await finalizeExperiment(
      jsonRequest(`/api/v1/experiments/${experiment.id}/finalize`, {}, { token: owner.token }),
      params({ id: experiment.id }),
    );
    expect(finalized.status).toBe(200);
    const finalizedBody = await finalized.json();
    expect(finalizedBody.experiment.status).toBe('completed');
    expect(finalizedBody.experiment.summary).not.toBeNull();
    expect(finalizedBody.experiment.summary.battles).toBe(1);
  });

  it('rejects a battle that did not run the named control and treatment', async () => {
    const owner = await makeDevice('experiment-mismatch-owner', 9402);
    const created = await createExperiment(
      jsonRequest('/api/v1/experiments', comparisonRequest(), { token: owner.token }),
    );
    const experiment: Experiment = (await created.json()).experiment;

    const battleId = freshBattleId();
    await createBattle(
      jsonRequest('/api/v1/battles', { record: demoRecord({ id: battleId }) }, { token: owner.token }),
    );

    // side "b" ran vanilla, not the treatment (agnostic-ai); side "a" (control here) ran agnostic-ai,
    // not the control (vanilla) -- labelling it the other way around must fail
    const mismatched = await linkBattle(
      jsonRequest(
        `/api/v1/experiments/${experiment.id}/battles`,
        { battleId, treatmentSide: 'b' },
        { token: owner.token },
      ),
      params({ id: experiment.id }),
    );
    expect(mismatched.status).toBe(400);
    const body = await mismatched.json();
    expect(body.error.code).toBe('invalid_request');
  });

  it("refuses a stranger linking a battle or finalizing someone else's experiment", async () => {
    const owner = await makeDevice('experiment-owned', 9403);
    const stranger = await makeDevice('experiment-stranger', 9404);
    const created = await createExperiment(
      jsonRequest('/api/v1/experiments', comparisonRequest(), { token: owner.token }),
    );
    const experiment: Experiment = (await created.json()).experiment;

    const battleId = freshBattleId();
    await createBattle(
      jsonRequest('/api/v1/battles', { record: demoRecord({ id: battleId }) }, { token: owner.token }),
    );

    const strangerLink = await linkBattle(
      jsonRequest(
        `/api/v1/experiments/${experiment.id}/battles`,
        { battleId, treatmentSide: 'a' },
        { token: stranger.token },
      ),
      params({ id: experiment.id }),
    );
    expect(strangerLink.status).toBe(403);

    const strangerFinalize = await finalizeExperiment(
      jsonRequest(`/api/v1/experiments/${experiment.id}/finalize`, {}, { token: stranger.token }),
      params({ id: experiment.id }),
    );
    expect(strangerFinalize.status).toBe(403);
  });
});
