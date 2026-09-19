import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OUTPUT_CAP_BYTES,
  PROCESS_OUTPUT_CAP_BYTES,
  createOutputCollector,
  runTests,
  shellInvocation,
} from '../src/index.js';
import { fakeRunner } from './helpers.js';

const cwd = path.join(os.tmpdir(), 'arena-run-tests');

describe('shellInvocation', () => {
  it('uses cmd.exe on Windows', () => {
    const invocation = shellInvocation('npm test -- --run', 'win32');
    expect(invocation.command.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(invocation.args).toEqual(['/d', '/s', '/c', 'npm test -- --run']);
  });

  it('uses sh elsewhere', () => {
    expect(shellInvocation('pytest -q', 'linux')).toEqual({ command: 'sh', args: ['-c', 'pytest -q'] });
    expect(shellInvocation('pytest -q', 'darwin')).toEqual({ command: 'sh', args: ['-c', 'pytest -q'] });
  });

  it('passes the command as a single argument, never interpolated', () => {
    const tricky = 'npm test -- --grep "a b" && echo done';
    const invocation = shellInvocation(tricky, 'linux');
    expect(invocation.args).toHaveLength(2);
    expect(invocation.args[1]).toBe(tricky);
  });
});

describe('createOutputCollector', () => {
  it('keeps the tail and reports how much it dropped', () => {
    const collector = createOutputCollector(1024);
    for (let i = 0; i < 500; i++) collector.push(`line ${i} ${'x'.repeat(50)}`);
    const text = collector.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
    expect(text).toContain('output truncated');
    expect(text).toContain('line 499');
    expect(text).not.toContain('line 0 ');
  });

  it('keeps everything when it fits', () => {
    const collector = createOutputCollector(1024);
    collector.push('one');
    collector.push('two');
    expect(collector.text()).toBe('one\ntwo');
  });
});

describe('runTests', () => {
  it('runs the command through the platform shell and parses the output', async () => {
    const runner = fakeRunner({
      stdout: ['      Tests  1 failed | 3 passed (4)', ' FAIL  test/math.test.ts > adds numbers'],
      exitCode: 1,
      durationMs: 42,
    });
    const outcome = await runTests({
      command: 'npm test',
      cwd,
      parser: 'auto',
      timeoutMs: 60_000,
      runner,
    });

    expect(outcome).toMatchObject({
      exitCode: 1,
      passed: 3,
      failed: 1,
      total: 4,
      parser: 'vitest',
      durationMs: 42,
    });
    expect(outcome.failingTests).toContain('test/math.test.ts > adds numbers');

    const call = runner.calls[0];
    expect(call).toBeDefined();
    expect(call?.cwd).toBe(cwd);
    expect(call?.timeoutMs).toBe(60_000);
    expect(call?.stdin).toBeNull();
    expect(call?.maxOutputBytes).toBe(PROCESS_OUTPUT_CAP_BYTES);
    const expected = shellInvocation('npm test');
    expect(call?.command).toBe(expected.command);
    expect(call?.args).toEqual(expected.args);
  });

  it('layers extra env over the process environment without dropping PATH', async () => {
    const runner = fakeRunner({});
    await runTests({ command: 'pytest', cwd, parser: 'pytest', timeoutMs: 1000, runner, env: { CI: '1' } });
    const env = runner.calls[0]?.env ?? {};
    expect(env.CI).toBe('1');
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path');
    if (pathKey) expect(env[pathKey]).toBe(process.env[pathKey]);
  });

  it('caps the captured output at 512 KB and still finds the summary at the end', async () => {
    const noise = Array.from({ length: 20_000 }, (_, i) => `noise ${i} ${'y'.repeat(60)}`);
    const runner = fakeRunner({
      stdout: [...noise, 'Tests:       1 failed, 3 passed, 4 total'],
      exitCode: 1,
    });
    const outcome = await runTests({ command: 'jest', cwd, parser: 'auto', timeoutMs: 1000, runner });

    expect(Buffer.byteLength(outcome.output)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    expect(outcome.output).toContain('output truncated');
    expect(outcome).toMatchObject({ passed: 3, failed: 1, total: 4, parser: 'jest' });
  });

  it('records a spawn failure in the output and reports null counts', async () => {
    const runner = fakeRunner({ exitCode: null, spawnError: 'spawn npm ENOENT' });
    const outcome = await runTests({ command: 'npm test', cwd, parser: 'auto', timeoutMs: 1000, runner });
    expect(outcome.exitCode).toBeNull();
    expect(outcome.output).toContain('spawn npm ENOENT');
    expect(outcome).toMatchObject({ passed: null, failed: null, parser: 'exit-code' });
  });

  it('records a timeout', async () => {
    const runner = fakeRunner({ exitCode: null, timedOut: true, stdout: ['starting'] });
    const outcome = await runTests({
      command: 'npm test',
      cwd,
      parser: 'exit-code',
      timeoutMs: 1234,
      runner,
    });
    expect(outcome.output).toContain('timed out after 1234 ms');
    expect(outcome.parser).toBe('exit-code');
  });

  it('measures its own duration when the runner reports none', async () => {
    const runner = fakeRunner({ durationMs: 0 });
    const outcome = await runTests({ command: 'true', cwd, parser: 'exit-code', timeoutMs: 1000, runner });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });
});
