import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProcessRunner, shellInvocation } from '@harness-arena/adapters';
import { OUTPUT_CAP_BYTES, PROCESS_OUTPUT_CAP_BYTES, createOutputCollector, runTests } from '../src/index.js';
import type { ProcessRunOptions, ProcessRunner } from '../src/index.js';
import { fakeRunner } from './helpers.js';

const cwd = path.join(os.tmpdir(), 'arena-run-tests');

/**
 * Regression for the Windows quoting bug: the shell line used to be handed to cmd.exe as a normal argv
 * element, so Node re-escaped it and `node -e "..."` ran something else (and could exit 0, reported as
 * a pass). The invocation now comes from `@harness-arena/adapters` and carries
 * `windowsVerbatimArguments`, which runTests must forward to the runner.
 */
describe('the shell invocation runTests hands to the runner', () => {
  const quoted = 'node -e "process.stdout.write(String(1+1))"';

  it('passes a command containing a double quote to the platform shell verbatim', async () => {
    const runner = fakeRunner({});
    await runTests({ command: quoted, cwd, parser: 'exit-code', timeoutMs: 1000, runner });

    const call = runner.calls[0];
    expect(call).toBeDefined();
    if (process.platform === 'win32') {
      expect(path.isAbsolute(call?.command ?? '')).toBe(true);
      expect(call?.command.toLowerCase()).toMatch(/cmd\.exe$/);
      expect(call?.args).toEqual(['/d', '/s', '/c', `"${quoted}"`]);
      expect(call?.windowsVerbatimArguments).toBe(true);
    } else {
      expect(call?.command).toBe('/bin/sh');
      expect(call?.args).toEqual(['-c', quoted]);
      expect(call?.windowsVerbatimArguments).toBe(false);
    }
    // whatever the platform, the user's double quotes survive into the last argument
    expect(call?.args.at(-1)).toContain('"process.stdout.write(String(1+1))"');
  });

  it('forwards exactly what shellInvocation produced, nothing of its own', async () => {
    const runner = fakeRunner({});
    await runTests({ command: quoted, cwd, parser: 'exit-code', timeoutMs: 1000, runner });
    const expected = shellInvocation(quoted);
    expect(runner.calls[0]?.command).toBe(expected.command);
    expect(runner.calls[0]?.args).toEqual(expected.args);
    expect(runner.calls[0]?.windowsVerbatimArguments).toBe(expected.windowsVerbatimArguments);
  });

  it.skipIf(process.platform !== 'win32')(
    'really runs a double-quoted node -e line through cmd.exe and captures its output',
    async () => {
      const outcome = await runTests({
        command: quoted,
        cwd: os.tmpdir(),
        parser: 'exit-code',
        timeoutMs: 60_000,
        runner: defaultProcessRunner,
      });
      expect(outcome.output.trim()).toBe('2');
      expect(outcome.exitCode).toBe(0);
    },
  );
});

/**
 * Finding 4: this package used to declare its own byte-for-byte copies of `Logger`/`ProcessRunner`.
 * The copies drifted the moment adapters added `windowsVerbatimArguments`, so the types are imported
 * now. This is a compile-time assertion with a runtime tail.
 */
describe('the process contract this package re-exports', () => {
  it('is the one @harness-arena/adapters owns, windowsVerbatimArguments included', () => {
    const runner: ProcessRunner = defaultProcessRunner;
    const opts: ProcessRunOptions = {
      command: 'node',
      args: ['-v'],
      windowsVerbatimArguments: true,
      cwd,
      env: {},
      stdin: null,
      signal: new AbortController().signal,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      onStdoutLine: () => {},
      onStderrLine: () => {},
    };
    expect(typeof runner.run).toBe('function');
    expect(opts.windowsVerbatimArguments).toBe(true);
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
