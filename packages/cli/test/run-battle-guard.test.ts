import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../src/program.js';
import { CliError, EXIT } from '../src/errors.js';
import { removeDir, stubAdapter, tempDir, testHarness } from './helpers.js';

/**
 * `arena run --battle <id>` against a battle the server says is finished: BATTLE_TRANSITIONS gives a
 * terminal status no next status, so the CLI refuses before anything runs instead of overwriting the
 * stored result under the same id.
 */

let home: string;

beforeEach(() => {
  home = tempDir('run-guard');
});

afterEach(() => {
  removeDir(home);
});

const ADAPTERS = [stubAdapter({ id: 'fake', displayName: 'Fake agent' })];

const SPEC = {
  version: 1,
  title: 'Server battle',
  task: { kind: 'prompt', prompt: 'server task' },
  repository: { source: 'empty' },
  competitors: {
    a: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
    b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
  },
  privacy: { upload: 'none' },
};

async function harnessServing(body: unknown) {
  const t = testHarness({
    home,
    adapters: ADAPTERS,
    fetchImpl: async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  await t.deps.createStateStore(home).setConfig({ token: 'tok_secret', serverUrl: 'https://arena.example' });
  return t;
}

async function runBattle(t: ReturnType<typeof testHarness>): Promise<void> {
  await createProgram(t.deps).parseAsync([
    'node',
    'arena',
    'run',
    '--battle',
    'btl_abcdefgh',
    '--local-only',
    '--home',
    home,
  ]);
}

describe('arena run --battle on a finished battle', () => {
  it.each(['completed', 'failed', 'cancelled'])(
    'refuses a battle the server reports as %s, with exit 1, and never starts the engine',
    async (status) => {
      const t = await harnessServing({ record: { status, spec: SPEC } });
      let caught: unknown;
      try {
        await runBattle(t);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CliError);
      const err = caught as CliError;
      expect(err.message).toMatch(/already finished/);
      expect(err.message).toContain('btl_abcdefgh');
      expect(err.message).toContain('Start a new one');
      expect(err.exitCode).toBe(1);
      expect(err.exitCode).toBe(EXIT.error);
      expect(t.specs).toHaveLength(0);
    },
  );

  it('still runs a body that carries only a spec', async () => {
    const t = await harnessServing({ spec: SPEC });
    await runBattle(t);
    expect(t.specs).toHaveLength(1);
  });

  it('still runs a battle the server reports as pending', async () => {
    const t = await harnessServing({ record: { status: 'pending', spec: SPEC } });
    await runBattle(t);
    expect(t.specs).toHaveLength(1);
  });
});
