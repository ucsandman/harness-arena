import { chmod, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProcessRunner, killProcessTree, LineSplitter } from '../src/process';
import { shellInvocation } from '../src/resolve';
import type { ProcessRunResult } from '../src/types';
import { makeTempDir, removeTempDir } from './helpers';

const NODE = process.execPath;

interface RunCapture {
  result: ProcessRunResult;
  stdout: string[];
  stderr: string[];
}

async function run(options: {
  args: string[];
  command?: string;
  stdin?: string | null;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  windowsVerbatimArguments?: boolean;
}): Promise<RunCapture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const controller = new AbortController();
  const result = await defaultProcessRunner.run({
    command: options.command ?? NODE,
    args: options.args,
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH ?? '' },
    stdin: options.stdin ?? null,
    signal: options.signal ?? controller.signal,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: options.maxOutputBytes ?? 10 * 1024 * 1024,
    onStdoutLine: (line) => stdout.push(line),
    onStderrLine: (line) => stderr.push(line),
    ...(options.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: options.windowsVerbatimArguments }),
  });
  return { result, stdout, stderr };
}

describe('LineSplitter', () => {
  it('handles CRLF, LF and chunk boundaries inside a line', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('one\r\ntw')).toEqual(['one']);
    expect(splitter.push('o\nthree')).toEqual(['two']);
    expect(splitter.flush()).toBe('three');
    expect(splitter.flush()).toBeNull();
  });
});

describe('defaultProcessRunner', () => {
  it('splits stdout and stderr into lines and reports exit 0', async () => {
    const { result, stdout, stderr } = await run({
      args: ['-e', "console.log('alpha'); console.log('beta'); process.stderr.write('warn one\\n')"],
    });

    expect(stdout).toEqual(['alpha', 'beta']);
    expect(stderr).toEqual(['warn one']);
    expect(result.exitCode).toBe(0);
    expect(result.spawnError).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.outputBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('normalizes CRLF output and delivers a final line without a newline', async () => {
    const { stdout } = await run({ args: ['-e', "process.stdout.write('x\\r\\ny\\r\\ntail')"] });
    expect(stdout).toEqual(['x', 'y', 'tail']);
  });

  it('propagates a non-zero exit code', async () => {
    const { result } = await run({ args: ['-e', 'process.exit(3)'] });
    expect(result.exitCode).toBe(3);
  });

  it('writes stdin and then closes it', async () => {
    const script =
      "let data=''; process.stdin.on('data', (c) => { data += c; }); process.stdin.on('end', () => console.log('got:' + data.trim()));";
    const { stdout, result } = await run({ args: ['-e', script], stdin: 'prompt text' });

    expect(stdout).toEqual(['got:prompt text']);
    expect(result.exitCode).toBe(0);
  });

  it('truncates and kills the child when maxOutputBytes is exceeded', async () => {
    const script =
      "const line = 'x'.repeat(1000) + '\\n'; for (let i = 0; i < 20000; i++) process.stdout.write(line);";
    const { result, stdout } = await run({ args: ['-e', script], maxOutputBytes: 50_000 });

    expect(result.truncated).toBe(true);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout.length).toBeLessThan(20000);
  });

  it('kills the process on timeout', async () => {
    const started = Date.now();
    const { result } = await run({ args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 400 });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('kills the process when the signal is aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    const { result } = await run({ args: ['-e', 'setTimeout(() => {}, 30000)'], signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await run({ args: ['-e', "console.log('never')"], signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBe(0);
  });

  it('reports spawnError when the binary does not exist', async () => {
    const { result } = await run({ command: 'harness-arena-missing-binary-xyz', args: ['--version'] });

    expect(result.spawnError).toContain('ENOENT');
    expect(result.exitCode).toBeNull();
  });
});

describe('defaultProcessRunner argument refusals', () => {
  it('records a spawn failure instead of throwing when an argument holds a null byte', async () => {
    const nullByte = String.fromCharCode(0);
    const { result } = await run({ args: ['-e', "console.log('never')", `nul${nullByte}byte`] });

    expect(result.spawnError).toMatch(/null byte/i);
    expect(result.exitCode).toBeNull();
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'records a spawn failure instead of throwing when argv holds a line break on a shim',
    async () => {
      const dir = await makeTempDir('arena-shim-');
      try {
        const shim = path.join(dir, 'agent.cmd');
        await writeFile(shim, '@echo off\r\necho shim %*\r\n', 'utf8');
        // cmd.exe reads CR and LF as command separators, so a multi-line argv entry is refused.
        const { result } = await run({ command: shim, args: ['line one\nline two'] });

        expect(result.spawnError).toMatch(/line break/i);
        expect(result.exitCode).toBeNull();
      } finally {
        await removeTempDir(dir);
      }
    },
  );

  it('still spawns the same shim when the argument is a single line', async () => {
    const dir = await makeTempDir('arena-shim-ok-');
    try {
      const isWindows = process.platform === 'win32';
      const shim = path.join(dir, isWindows ? 'agent.cmd' : 'agent.sh');
      const body = isWindows ? '@echo off\r\necho shim %1\r\n' : '#!/bin/sh\necho shim "$1"\n';
      await writeFile(shim, body, 'utf8');
      await chmod(shim, 0o755);
      const { result, stdout } = await run({ command: shim, args: ['one-line'] });

      expect(result.spawnError).toBeNull();
      expect(result.exitCode).toBe(0);
      // cmd.exe echoes %1 with the quoting execa applied, so only the value itself is asserted.
      expect(stdout.join('\n')).toMatch(/shim "?one-line"?/);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('runs a shell command line through the absolute shell, verbatim on Windows', async () => {
    const invocation = shellInvocation('echo arena-shell-ok');
    const { result, stdout } = await run({
      command: invocation.command,
      args: invocation.args,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    expect(result.spawnError).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(stdout.join('\n')).toContain('arena-shell-ok');
  });
});

describe('killProcessTree', () => {
  it('ignores an invalid pid instead of throwing', async () => {
    await expect(killProcessTree(0)).resolves.toBeUndefined();
    await expect(killProcessTree(-1)).resolves.toBeUndefined();
  });

  it('does not throw for a pid that has already exited', async () => {
    const { result } = await run({ args: ['-e', 'process.exit(0)'] });
    expect(result.exitCode).toBe(0);
    await expect(killProcessTree(999_999)).resolves.toBeUndefined();
  });
});
