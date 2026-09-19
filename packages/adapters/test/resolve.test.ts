import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findBinary } from '../src/detect';
import { shellInvocation } from '../src/resolve';
import { makeTempDir, removeTempDir } from './helpers';

const PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** A directory an attacker controls: a battle workspace the agent CLI is spawned in. */
let dropDir: string;
/** The only directory on PATH; it holds no agent CLI. */
let emptyDir: string;

beforeEach(async () => {
  dropDir = await makeTempDir('arena-drop-');
  emptyDir = await makeTempDir('arena-empty-path-');
  // Both naming conventions, so the hijack is realistic on Windows and on POSIX.
  await writeFile(path.join(dropDir, 'claude.cmd'), '@echo off\r\necho hijacked\r\n', 'utf8');
  await writeFile(path.join(dropDir, 'claude'), '#!/bin/sh\necho hijacked\n', 'utf8');
  await chmod(path.join(dropDir, 'claude'), 0o755);
});

afterEach(async () => {
  await removeTempDir(dropDir);
  await removeTempDir(emptyDir);
});

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

describe('findBinary', () => {
  it('ignores a binary dropped in the working directory when PATH does not list it', async () => {
    const found = await inDir(dropDir, () => findBinary(['claude'], { PATH: emptyDir, PATHEXT }));
    expect(found).toBeNull();
  });

  it('applies the Windows PATHEXT rules without ever searching the working directory', async () => {
    await inDir(dropDir, async () => {
      // platform is injected so the Windows resolution rules are exercised on Linux too
      const hijacked = await findBinary(['claude'], { PATH: emptyDir, PATHEXT }, { platform: 'win32' });
      expect(hijacked).toBeNull();

      const found = await findBinary(['claude'], { PATH: dropDir, PATHEXT }, { platform: 'win32' });
      expect(found?.toLowerCase()).toBe(path.join(dropDir, 'claude.cmd').toLowerCase());
    });
  });

  it('ignores a relative PATH entry, which would resolve against the working directory', async () => {
    const found = await inDir(dropDir, () =>
      findBinary(['claude'], { PATH: `.${path.delimiter}..`, PATHEXT }),
    );
    expect(found).toBeNull();
  });

  it('finds the binary when PATH lists its directory explicitly', async () => {
    const found = await findBinary(['claude'], { PATH: `${emptyDir}${path.delimiter}${dropDir}`, PATHEXT });
    expect(found).not.toBeNull();
    expect(path.dirname(found ?? '')).toBe(dropDir);
  });
});

describe('shellInvocation', () => {
  it('runs a posix command line through /bin/sh -c', () => {
    expect(shellInvocation('npm test', 'linux')).toEqual({
      command: '/bin/sh',
      args: ['-c', 'npm test'],
      windowsVerbatimArguments: false,
    });
  });

  it('runs a Windows command line through an absolute cmd.exe with verbatim arguments', () => {
    const invocation = shellInvocation('npm test', 'win32');

    expect(path.win32.isAbsolute(invocation.command)).toBe(true);
    expect(invocation.command.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(invocation.args).toEqual(['/d', '/s', '/c', '"npm test"']);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it('never takes the shell from the working directory when ComSpec is relative', () => {
    const previous = process.env.ComSpec;
    process.env.ComSpec = 'cmd.exe';
    try {
      const invocation = shellInvocation('npm test', 'win32');
      expect(path.win32.isAbsolute(invocation.command)).toBe(true);
      expect(invocation.command.toLowerCase()).toContain('system32');
    } finally {
      if (previous === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = previous;
    }
  });
});
