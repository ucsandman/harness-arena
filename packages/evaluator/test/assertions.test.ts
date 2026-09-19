import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Assertion } from '@harness-arena/protocol';
import { assertionSchema } from '@harness-arena/protocol';
import { assertionsEvaluator, checkAssertion, makeSideContext, matchesGlob } from '../src/index.js';
import { fakeRunner, makeCtx, makeSpec, shellLineOf } from './helpers.js';

let workspace: string;

const changedFiles = [
  { path: 'src/math.ts', kind: 'modify' as const, linesAdded: 2, linesRemoved: 1 },
  { path: 'test/math.test.ts', kind: 'create' as const, linesAdded: 10, linesRemoved: 0 },
];

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-assert-'));
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Demo project\nUses Vitest for tests.\n', 'utf8');
  await fs.writeFile(
    path.join(workspace, 'src', 'math.ts'),
    'export const add = (a: number, b: number) => a + b;\n',
    'utf8',
  );
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function parse(assertion: unknown): Assertion {
  return assertionSchema.parse(assertion);
}

async function check(assertion: unknown, opts: { exitCode?: number | null } = {}) {
  const { ctx } = makeCtx({
    runner: fakeRunner({ exitCode: opts.exitCode === undefined ? 0 : opts.exitCode }),
    a: { workspace, artifacts: { changedFiles } },
  });
  return checkAssertion(parse(assertion), ctx, ctx.sides.a);
}

describe('matchesGlob', () => {
  it('handles *, ** and plain prefixes', () => {
    expect(matchesGlob('src/math.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/math.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('src/deep/math.ts', 'src/**')).toBe(true);
    expect(matchesGlob('src/deep/math.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('math.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/math.ts', 'src')).toBe(true);
    expect(matchesGlob('srcx/math.ts', 'src')).toBe(false);
    expect(matchesGlob('src\\math.ts', 'src/*.ts')).toBe(true);
  });
});

describe('checkAssertion', () => {
  it('file-exists passes and fails', async () => {
    await expect(check({ type: 'file-exists', path: 'README.md' })).resolves.toMatchObject({ passed: true });
    await expect(check({ type: 'file-exists', path: 'MISSING.md' })).resolves.toMatchObject({
      passed: false,
    });
  });

  it('file-missing passes and fails', async () => {
    await expect(check({ type: 'file-missing', path: 'MISSING.md' })).resolves.toMatchObject({
      passed: true,
    });
    await expect(check({ type: 'file-missing', path: 'README.md' })).resolves.toMatchObject({
      passed: false,
    });
  });

  it('file-contains uses the regex and its flags', async () => {
    await expect(
      check({ type: 'file-contains', path: 'README.md', pattern: 'Demo project' }),
    ).resolves.toMatchObject({
      passed: true,
    });
    await expect(
      check({ type: 'file-contains', path: 'README.md', pattern: 'demo PROJECT', flags: 'i' }),
    ).resolves.toMatchObject({ passed: true });
    await expect(
      check({ type: 'file-contains', path: 'README.md', pattern: 'demo PROJECT' }),
    ).resolves.toMatchObject({ passed: false });
    await expect(check({ type: 'file-contains', path: 'MISSING.md', pattern: 'x' })).resolves.toMatchObject({
      passed: false,
      detail: 'file not found',
    });
  });

  it('file-not-contains fails when the pattern is present', async () => {
    await expect(
      check({ type: 'file-not-contains', path: 'src/math.ts', pattern: 'console\\.log' }),
    ).resolves.toMatchObject({ passed: true });
    await expect(
      check({ type: 'file-not-contains', path: 'src/math.ts', pattern: 'export const add' }),
    ).resolves.toMatchObject({ passed: false });
  });

  it('rejects an invalid regex instead of throwing', async () => {
    const outcome = await check({ type: 'file-contains', path: 'README.md', pattern: '(' });
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain('invalid pattern');
  });

  it('refuses paths that escape the workspace', async () => {
    const outcome = await check({ type: 'file-exists', path: '../outside.txt' });
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain('escapes the workspace');
  });

  it('command compares the exit code with the expectation', async () => {
    await expect(
      check({ type: 'command', command: 'npm run build' }, { exitCode: 0 }),
    ).resolves.toMatchObject({
      passed: true,
    });
    await expect(
      check({ type: 'command', command: 'npm run build' }, { exitCode: 1 }),
    ).resolves.toMatchObject({
      passed: false,
      detail: 'exit 1 (expected 0)',
    });
    await expect(
      check({ type: 'command', command: 'test -f x', expectExitCode: 1 }, { exitCode: 1 }),
    ).resolves.toMatchObject({ passed: true });
  });

  it('command runs in the workspace through the shell with its own timeout', async () => {
    const runner = fakeRunner({ exitCode: 0 });
    const { ctx } = makeCtx({ runner, a: { workspace, artifacts: { changedFiles } } });
    await checkAssertion(
      parse({ type: 'command', command: 'npm run build', timeoutMs: 4321 }),
      ctx,
      ctx.sides.a,
    );
    expect(runner.calls[0]?.cwd).toBe(workspace);
    expect(runner.calls[0]?.timeoutMs).toBe(4321);
    const call = runner.calls[0];
    expect(call).toBeDefined();
    if (call) expect(shellLineOf(call)).toBe('npm run build');
  });

  it('diff-touches and diff-not-touches match changed paths by glob', async () => {
    await expect(check({ type: 'diff-touches', paths: ['src/**'] })).resolves.toMatchObject({ passed: true });
    await expect(check({ type: 'diff-touches', paths: ['docs/**'] })).resolves.toMatchObject({
      passed: false,
    });
    await expect(check({ type: 'diff-not-touches', paths: ['docs/**'] })).resolves.toMatchObject({
      passed: true,
    });
    await expect(check({ type: 'diff-not-touches', paths: ['**/*.test.ts'] })).resolves.toMatchObject({
      passed: false,
    });
  });

  it('falls back to the diff headers when changedFiles is empty', async () => {
    const diff = [
      'diff --git a/src/math.ts b/src/math.ts',
      '--- a/src/math.ts',
      '+++ b/src/math.ts',
      '@@ -1 +1 @@',
      '-export const add = 0;',
      '+export const add = 1;',
    ].join('\n');
    const { ctx } = makeCtx({ a: { workspace, artifacts: { changedFiles: [], diff } } });
    await expect(
      checkAssertion(parse({ type: 'diff-touches', paths: ['src/math.ts'] }), ctx, ctx.sides.a),
    ).resolves.toMatchObject({ passed: true });
  });

  it('max-files-changed counts the changed files', async () => {
    await expect(check({ type: 'max-files-changed', max: 2 })).resolves.toMatchObject({ passed: true });
    await expect(check({ type: 'max-files-changed', max: 1 })).resolves.toMatchObject({
      passed: false,
      detail: '2 file(s) changed (max 1)',
    });
  });
});

describe('assertionsEvaluator', () => {
  it('does not apply without assertions and applies with them', () => {
    const { ctx: empty } = makeCtx({});
    expect(assertionsEvaluator.applies(empty)).toBe(false);
    const spec = makeSpec({ evaluation: { assertions: [{ type: 'file-exists', path: 'README.md' }] } });
    const { ctx } = makeCtx({ spec });
    expect(assertionsEvaluator.applies(ctx)).toBe(true);
  });

  it('aggregates per side with a score and per-assertion detail', async () => {
    const spec = makeSpec({
      evaluation: {
        assertions: [
          { type: 'file-exists', path: 'README.md' },
          { type: 'file-exists', path: 'MISSING.md', label: 'changelog written' },
        ],
      },
    });
    const { ctx } = makeCtx({
      spec,
      a: { workspace, artifacts: { changedFiles } },
      b: { workspace, artifacts: { changedFiles } },
    });
    const results = await assertionsEvaluator.run(ctx);
    expect(results).toHaveLength(2);
    const first = results[0];
    expect(first?.side).toBe('a');
    expect(first?.status).toBe('failed');
    expect(first?.score).toBe(0.5);
    expect(first?.summary).toBe('1/2 assertions passed');
    const details = first?.details as { checks: Array<{ label: string; passed: boolean }> };
    expect(details.checks.map((c) => c.label)).toEqual(['README.md exists', 'changelog written']);
    expect(details.checks.map((c) => c.passed)).toEqual([true, false]);
  });

  it('checks a side that did not complete too', async () => {
    const spec = makeSpec({ evaluation: { assertions: [{ type: 'file-exists', path: 'README.md' }] } });
    const { ctx } = makeCtx({ spec, a: { workspace }, b: { workspace, status: 'failed' } });
    const results = await assertionsEvaluator.run(ctx);
    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(makeSideContext({ workspace }).status).toBe('completed');
  });
});
