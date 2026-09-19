import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BattleRecord, BattleSpecInput } from '@harness-arena/protocol';
import { FAKE_DEMO_PROJECT_DIR } from '@harness-arena/adapters';
import { runBattle } from './engine.js';
import type { RunBattleOptions } from './engine.js';
import { initRepoFromDirectory } from './git.js';

/**
 * The demo battle: two deterministic fake runs over a greenfield repository, so `arena demo` works
 * on a machine with no agent CLI installed, no network access and no model spend. The harnesses are
 * displayed with their real names and sources but are never fetched (see `demo` in runBattle).
 */

export const DEMO_PROMPT = [
  'Fix the failing session-expiry test in the auth module: sessions expire one hour early because the',
  'expiry comparison mixes seconds and milliseconds. Make the test suite pass without changing the',
  'public API.',
].join(' ');

export function createDemoSpec(repositorySource = 'empty'): BattleSpecInput {
  return {
    version: 1,
    title: 'Fix the session-expiry bug',
    task: { kind: 'prompt', title: 'Fix the session-expiry bug', prompt: DEMO_PROMPT },
    repository: { source: repositorySource },
    competitors: {
      a: {
        label: 'Agnostic AI',
        agent: { id: 'fake' },
        harness: { source: 'https://github.com/ucsandman/agnostic-ai', trusted: true },
        fixture: 'demo-harness-a',
      },
      b: {
        label: 'Vanilla Claude Code',
        agent: { id: 'fake' },
        harness: { source: 'vanilla' },
        fixture: 'demo-vanilla-b',
      },
    },
    limits: { timeoutMs: 15 * 60_000 },
    evaluation: {
      tests: { command: 'node --test', baseline: true },
      assertions: [
        {
          type: 'file-contains',
          path: 'src/auth/session.js',
          pattern: '\\*\\s*1000|1000\\s*\\*|/\\s*1000',
          label: 'the expiry comparison converts between seconds and milliseconds',
        },
        {
          type: 'diff-not-touches',
          paths: ['package.json'],
          label: 'the public API and dependencies are untouched',
        },
      ],
    },
    privacy: { upload: 'none' },
    tags: ['demo'],
    category: 'debugging',
  };
}

/**
 * Seed the demo repository (the small Node project the fake fixtures start from) under ARENA_HOME so the
 * fake runs modify a real pre-existing project: baseline tests fail, the fix makes them pass, and the diff
 * shows only what the "agent" changed. Idempotent: an existing seed is reused.
 */
export async function ensureDemoRepository(home?: string): Promise<string> {
  const base = home ?? process.env.ARENA_HOME ?? path.join(os.homedir(), '.harness-arena');
  const dest = path.join(base, 'demo', 'session-expiry');
  if (!fs.existsSync(path.join(dest, '.git'))) {
    await initRepoFromDirectory(dest, FAKE_DEMO_PROJECT_DIR, { home: base });
  }
  return dest;
}

export async function runDemoBattle(opts: RunBattleOptions = {}): Promise<BattleRecord> {
  const repo = await ensureDemoRepository(opts.home);
  return runBattle(createDemoSpec(repo), { ...opts, demo: true });
}
