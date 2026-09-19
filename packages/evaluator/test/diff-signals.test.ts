import { describe, expect, it } from 'vitest';
import type { RunArtifacts } from '@harness-arena/protocol';
import { collectDiffSignals, diffSignalsEvaluator, isLockfilePath, isTestPath } from '../src/index.js';
import { makeCtx } from './helpers.js';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,5 @@',
  '+// TODO: handle errors',
  '+console.log("debugging");',
  '-const old = 1;',
].join('\n');

const ARTIFACTS: RunArtifacts = {
  diff: DIFF,
  changedFiles: [
    { path: 'src/app.ts', kind: 'modify', linesAdded: 2, linesRemoved: 1 },
    { path: 'test/app.test.ts', kind: 'delete', linesAdded: 0, linesRemoved: 20 },
    { path: 'pnpm-lock.yaml', kind: 'modify', linesAdded: 5, linesRemoved: 2 },
  ],
};

function signal(artifacts: RunArtifacts, id: string) {
  return collectDiffSignals(artifacts).signals.find((s) => s.id === id);
}

describe('path classifiers', () => {
  it('recognizes test paths without false positives', () => {
    expect(isTestPath('test/app.test.ts')).toBe(true);
    expect(isTestPath('src/__tests__/app.ts')).toBe(true);
    expect(isTestPath('src/app.spec.ts')).toBe(true);
    expect(isTestPath('src/latest.ts')).toBe(false);
    expect(isTestPath('src/contest.ts')).toBe(false);
  });

  it('recognizes lockfiles', () => {
    expect(isLockfilePath('pnpm-lock.yaml')).toBe(true);
    expect(isLockfilePath('sub/dir/package-lock.json')).toBe(true);
    expect(isLockfilePath('Cargo.lock')).toBe(true);
    expect(isLockfilePath('src/lockfile.ts')).toBe(false);
  });
});

describe('collectDiffSignals', () => {
  it('counts files and lines from changedFiles', () => {
    const details = collectDiffSignals(ARTIFACTS);
    expect(details).toMatchObject({ filesChanged: 3, linesAdded: 7, linesRemoved: 23 });
  });

  it('flags tests, deleted tests, lockfiles, TODOs and debug logging', () => {
    expect(signal(ARTIFACTS, 'touches_tests')?.value).toBe(true);
    expect(signal(ARTIFACTS, 'deletes_tests')?.value).toBe(true);
    expect(signal(ARTIFACTS, 'deletes_tests')?.note).toBe('test/app.test.ts');
    expect(signal(ARTIFACTS, 'touches_lockfiles')?.value).toBe(true);
    expect(signal(ARTIFACTS, 'adds_todo')?.value).toBe(1);
    expect(signal(ARTIFACTS, 'adds_debug_logging')?.value).toBe(1);
  });

  it('flags a very large diff only above the threshold', () => {
    const small: RunArtifacts = {
      changedFiles: [{ path: 'a.ts', kind: 'modify', linesAdded: 500, linesRemoved: 500 }],
    };
    const big: RunArtifacts = {
      changedFiles: [{ path: 'a.ts', kind: 'modify', linesAdded: 900, linesRemoved: 200 }],
    };
    expect(signal(small, 'large_diff')?.value).toBe(false);
    expect(signal(big, 'large_diff')?.value).toBe(true);
    expect(signal(big, 'large_diff')?.note).toBe('1100 line(s) changed');
  });

  it('flags an empty diff', () => {
    const empty: RunArtifacts = { changedFiles: [] };
    expect(signal(empty, 'empty_diff')?.value).toBe(true);
    expect(signal(ARTIFACTS, 'empty_diff')?.value).toBe(false);
  });

  it('counts lines from the diff when changedFiles is missing', () => {
    const details = collectDiffSignals({ diff: DIFF, changedFiles: [] });
    expect(details).toMatchObject({ filesChanged: 1, linesAdded: 2, linesRemoved: 1 });
  });
});

describe('diffSignalsEvaluator', () => {
  it('always applies and never judges', async () => {
    const { ctx } = makeCtx({
      a: { artifacts: ARTIFACTS },
      b: { artifacts: { changedFiles: [] }, status: 'failed' },
    });
    expect(diffSignalsEvaluator.applies(ctx)).toBe(true);
    const results = await diffSignalsEvaluator.run(ctx);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe('passed');
      expect(result.score).toBeNull();
      expect(result.kind).toBe('deterministic');
    }
    expect(results[0]?.summary).toContain('3 file(s), +7/-23');
    expect(results[1]?.summary).toContain('0 file(s)');
  });
});
