import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeDir, tempDir } from './helpers.js';

/**
 * `removeWorktree` cleanup, with git mocked so the failure path is reachable on every platform: a
 * Windows file lock (an editor, a scanner, a lingering child) makes the fallback delete throw, and the
 * mirror must still be pruned or it keeps a registration for a directory nobody will clean up.
 */

const calls: string[][] = [];
let removeExitCode = 0;

vi.mock('execa', () => ({
  execa: async (_file: string, args: string[]) => {
    calls.push(args);
    const isRemove = args.includes('worktree') && args.includes('remove');
    return {
      exitCode: isRemove ? removeExitCode : 0,
      stdout: '',
      stderr: '',
    };
  },
}));

const { removeWorktree } = await import('../src/git.js');

let root: string;
let dest: string;

beforeEach(() => {
  root = tempDir('git-remove');
  dest = path.join(root, 'workspace');
  fs.mkdirSync(dest, { recursive: true });
  calls.length = 0;
  removeExitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  removeDir(root);
});

const gitArgs = (): string[][] => calls.map((c) => c.filter((a) => a !== '-c' && !a.includes('=')));

describe('removeWorktree', () => {
  it('prunes the mirror even when the fallback delete cannot remove the directory', async () => {
    removeExitCode = 1;
    const rmSync = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });

    await expect(removeWorktree({ mirror: path.join(root, 'mirror.git'), dest, home: root })).rejects.toThrow(
      /EBUSY/,
    );

    // The retry options are what make a transient Windows lock survivable.
    expect(rmSync).toHaveBeenCalledWith(
      dest,
      expect.objectContaining({ recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    );
    expect(gitArgs()).toContainEqual(['worktree', 'prune']);
  });

  it('prunes after a successful removal too', async () => {
    await removeWorktree({ mirror: path.join(root, 'mirror.git'), dest, home: root });
    expect(gitArgs().at(-1)).toEqual(['worktree', 'prune']);
  });
});
