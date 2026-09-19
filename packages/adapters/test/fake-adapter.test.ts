import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../src/fake/adapter';
import { listFakeFixtures, loadFakeFixture } from '../src/fake/fixtures';
import {
  countByType,
  makeExecuteContext,
  makePrepareContext,
  makeTempDir,
  removeTempDir,
  TEST_LIMITS,
} from './helpers';

const NO_RUNNER = {
  run: async () => {
    throw new Error('the fake adapter must never spawn a process');
  },
};

let workspace: string;

beforeEach(async () => {
  workspace = await makeTempDir('arena-fake-ws-');
});

afterEach(async () => {
  await removeTempDir(workspace);
});

async function replay(
  fixture: string,
  options: { realtime?: boolean; speed?: number } = {},
  limits = TEST_LIMITS,
) {
  const adapter = new FakeAdapter(options);
  const prepared = await adapter.prepare(makePrepareContext({ workspace, fixture }));
  const harness = makeExecuteContext(NO_RUNNER, limits);
  const result = await adapter.execute(prepared, harness.ctx);
  return {
    result,
    events: harness.events,
    counts: countByType(harness.events),
    controller: harness.controller,
  };
}

describe('builtin fake fixtures', () => {
  it('ships the seven fixtures the CLI and tests rely on', async () => {
    await expect(listFakeFixtures()).resolves.toEqual([
      'demo-harness-a',
      'demo-vanilla-b',
      'failure',
      'interrupted',
      'quick-success',
      'timeout',
      'usage-limit',
    ]);
  });

  it('validates every builtin fixture against the protocol payload schemas', async () => {
    for (const name of await listFakeFixtures()) {
      const script = await loadFakeFixture(name);
      expect(script.name).toBe(name);
      expect(script.steps.length).toBeGreaterThan(0);
    }
  });

  it('rejects a fixture whose file operation escapes the workspace', async () => {
    const file = path.join(workspace, 'evil.json');
    await writeFile(
      file,
      JSON.stringify({
        name: 'evil',
        agentVersion: 'fake-1.0.0',
        steps: [{ atMs: 0, fs: { op: 'write', path: '../escaped.txt', content: 'nope' } }],
        result: { status: 'completed', exitCode: 0, finalResponse: null, usage: null, turns: 1 },
      }),
      'utf8',
    );

    await expect(loadFakeFixture(file)).rejects.toThrow(/workspace-relative/);
  });

  it('rejects an absolute path in a file operation', async () => {
    const file = path.join(workspace, 'absolute.json');
    await writeFile(
      file,
      JSON.stringify({
        name: 'absolute',
        agentVersion: 'fake-1.0.0',
        steps: [{ atMs: 0, fs: { op: 'write', path: path.join(workspace, 'x.txt'), content: 'nope' } }],
        result: { status: 'completed', exitCode: 0, finalResponse: null, usage: null, turns: 1 },
      }),
      'utf8',
    );

    await expect(loadFakeFixture(file)).rejects.toThrow(/workspace-relative/);
  });

  it('refuses a fixture name that is not a builtin or an absolute path', async () => {
    await expect(loadFakeFixture('../../etc/passwd')).rejects.toThrow(/builtin name/);
  });
});

describe('FakeAdapter replay', () => {
  it('replays quick-success with five events and one real file write', async () => {
    const { result, counts, events } = await replay('quick-success');

    expect(counts).toEqual({
      'agent.started': 1,
      'tool.called': 1,
      'file.changed': 1,
      'model.response': 1,
      'agent.output': 1,
    });
    expect(events.every((e) => typeof e.at === 'number')).toBe(true);
    await expect(readFile(path.join(workspace, 'NOTES.md'), 'utf8')).resolves.toContain('quick-success');
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 180, costUsd: 0.0042 });
    expect(result.turns).toBe(1);
  });

  it('keeps event offsets deterministic relative to the run start', async () => {
    const { events } = await replay('quick-success');
    const first = events[0]?.at ?? 0;
    expect(events.map((e) => (e.at ?? 0) - first)).toEqual([0, 400, 400, 1500, 2000]);
  });

  it('replays demo-harness-a: 63 tool calls, one subagent, two test runs, green tests', async () => {
    const { result, counts } = await replay('demo-harness-a');

    expect(counts['tool.called']).toBe(63);
    expect(counts['tool.result']).toBe(63);
    expect(counts['file.read']).toBe(6);
    expect(counts['command.started']).toBe(2);
    expect(counts['command.completed']).toBe(2);
    expect(counts['subagent.spawned']).toBe(1);
    expect(counts['subagent.completed']).toBe(1);
    expect(counts['file.changed']).toBe(2);
    expect(counts['model.response']).toBe(15); // 14 turns plus the final summary
    expect(result.status).toBe('completed');
    expect(result.usage).toEqual({
      inputTokens: 182_000,
      outputTokens: 9400,
      cacheReadTokens: 120_000,
      costUsd: 2.81,
    });
    expect(result.turns).toBe(14);

    const tests = await execa('node', ['--test'], { cwd: workspace, reject: false });
    expect(tests.exitCode, `node --test failed:\n${tests.stdout}\n${tests.stderr}`).toBe(0);
    expect(tests.stdout).toMatch(/pass 4/);
    expect(tests.stdout).toMatch(/fail 0/);
  });

  it('replays demo-vanilla-b: 147 tool calls, four test runs, two retries, green tests', async () => {
    const { result, counts } = await replay('demo-vanilla-b');

    expect(counts['tool.called']).toBe(147);
    expect(counts['file.read']).toBe(18);
    expect(counts['command.started']).toBe(4);
    expect(counts.warning).toBe(2);
    expect(counts['subagent.spawned']).toBeUndefined();
    expect(counts['file.changed']).toBe(3);
    expect(result.usage).toEqual({ inputTokens: 391_000, outputTokens: 21_000, costUsd: 6.42 });
    expect(result.turns).toBe(27);

    const tests = await execa('node', ['--test'], { cwd: workspace, reject: false });
    expect(tests.exitCode, `node --test failed:\n${tests.stdout}\n${tests.stderr}`).toBe(0);
    expect(tests.stdout).toMatch(/pass 3/);
    expect(tests.stdout).toMatch(/fail 0/);
    await expect(readFile(path.join(workspace, 'README.md'), 'utf8')).resolves.toContain('## Notes');
  });

  it('per-turn usage shares add up to the run totals', async () => {
    const { events } = await replay('demo-harness-a');
    const perTurn = events.filter((e) => e.type === 'model.response' && e.native === 'assistant/usage');
    const sum = perTurn.reduce(
      (acc, e) => {
        const usage = e.type === 'model.response' ? (e.payload.usage ?? {}) : {};
        return {
          inputTokens: acc.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: acc.outputTokens + (usage.outputTokens ?? 0),
          cacheReadTokens: acc.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          costUsd: acc.costUsd + (usage.costUsd ?? 0),
        };
      },
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    );

    expect(perTurn).toHaveLength(14);
    expect(sum.inputTokens).toBe(182_000);
    expect(sum.outputTokens).toBe(9400);
    expect(sum.cacheReadTokens).toBe(120_000);
    expect(sum.costUsd).toBeCloseTo(2.81, 6);
  });

  it('reports failure and usage-limit fixtures as the fixture declares', async () => {
    const failure = await replay('failure');
    expect(failure.result.status).toBe('failed');
    expect(failure.result.exitCode).toBe(1);
    expect(failure.counts.error).toBe(1);

    const limit = await replay('usage-limit');
    expect(limit.result.status).toBe('failed');
    expect(limit.result.errorCode).toBe('provider_limit');
    expect(limit.counts['limit.hit']).toBe(1);
  });

  it('stops with timed_out and a timeout limit when the timeline outlasts limits.timeoutMs', async () => {
    const { result, counts } = await replay('timeout', {}, { ...TEST_LIMITS, timeoutMs: 60_000 });

    expect(result.status).toBe('timed_out');
    expect(result.errorCode).toBe('timeout');
    expect(counts['limit.hit']).toBe(1);
    // Only the steps inside the window were replayed.
    expect(counts['tool.called']).toBe(1);
  });

  it('reports interrupted when the signal is already aborted', async () => {
    const adapter = new FakeAdapter();
    const prepared = await adapter.prepare(makePrepareContext({ workspace, fixture: 'interrupted' }));
    const harness = makeExecuteContext(NO_RUNNER);
    harness.controller.abort();

    const result = await adapter.execute(prepared, harness.ctx);
    expect(result.status).toBe('interrupted');
    expect(result.errorCode).toBe('interrupted');
    expect(harness.events.map((e) => e.type)).toEqual(['interrupt']);
  });

  it('reports interrupted when aborted mid-replay in realtime mode', async () => {
    const adapter = new FakeAdapter({ realtime: true, speed: 500 });
    const prepared = await adapter.prepare(makePrepareContext({ workspace, fixture: 'interrupted' }));
    const harness = makeExecuteContext(NO_RUNNER);
    const timer = setTimeout(() => harness.controller.abort(), 25);

    const result = await adapter.execute(prepared, harness.ctx);
    clearTimeout(timer);

    expect(result.status).toBe('interrupted');
    expect(harness.events.at(-1)?.type).toBe('interrupt');
    expect((result.native as { stepsReplayed: number }).stepsReplayed).toBeLessThan(121);
  });

  it('detects as installed without touching the filesystem or a provider', async () => {
    const detection = await new FakeAdapter().detect();
    expect(detection).toMatchObject({ id: 'fake', installed: true, auth: 'ok' });
    expect(await new FakeAdapter().getVersion()).toBe('fake-1.0.0');
  });
});
