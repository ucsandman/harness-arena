import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_DIFF_BYTES,
  createWorktree,
  diffStats,
  ensureMirror,
  gitVersion,
  initEmptyRepo,
  isDirty,
  isGitRepo,
  isLocalSource,
  removeWorktree,
  resolveCommit,
  resolveRemoteHead,
  toGitPath,
} from '../src/git.js';
import { removeDir, tempDir } from './helpers.js';

/** Git may normalise line endings on checkout (core.autocrlf on Windows); compare content, not CRLF. */
const readText = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/** Real git, in a temp directory. No network: every remote is a local path. */

const IDENTITY = [
  '-c',
  'user.name=Arena Test',
  '-c',
  'user.email=test@localhost',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'protocol.file.allow=always',
];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa('git', [...IDENTITY, ...args], { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error('git ' + args.join(' ') + ' failed: ' + String(result.stderr || result.stdout));
  }
  return String(result.stdout ?? '');
}

let root: string;
let home: string;
let source: string;
let firstCommit: string;
let headCommit: string;

beforeAll(async () => {
  root = tempDir('git');
  home = path.join(root, 'home');
  source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });
  await git(source, ['-c', 'init.defaultBranch=main', 'init']);
  fs.writeFileSync(path.join(source, 'a.txt'), 'version one\n');
  fs.writeFileSync(path.join(source, 'b.txt'), 'to be deleted\n');
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-m', 'first']);
  firstCommit = (await git(source, ['rev-parse', 'HEAD'])).trim();
  fs.writeFileSync(path.join(source, 'a.txt'), 'version two\n');
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-m', 'second']);
  headCommit = (await git(source, ['rev-parse', 'HEAD'])).trim();
}, 60_000);

afterAll(() => {
  removeDir(root);
});

describe('source classification', () => {
  it('tells local paths from URLs', () => {
    expect(isLocalSource('C:\\Projects\\thing')).toBe(true);
    expect(isLocalSource('/home/me/thing')).toBe(true);
    expect(isLocalSource('./thing')).toBe(true);
    expect(isLocalSource('https://github.com/a/b')).toBe(false);
    expect(isLocalSource('git@github.com:a/b.git')).toBe(false);
    expect(isLocalSource('ssh://git@host/a/b')).toBe(false);
  });

  it('always hands git forward slashes', () => {
    expect(toGitPath('C:\\a\\b')).toBe('C:/a/b');
  });
});

describe('repository inspection', () => {
  it('reports the git version', async () => {
    const version = await gitVersion({ home });
    expect(version).toMatch(/^\d+\.\d+/);
  });

  it('recognises a repository and a non-repository', async () => {
    expect(await isGitRepo(source, { home })).toBe(true);
    expect(await isGitRepo(path.join(root, 'does-not-exist'), { home })).toBe(false);
  });

  it('detects a dirty checkout, including untracked files', async () => {
    expect(await isDirty(source, { home })).toBe(false);
    const scratch = path.join(source, 'untracked.txt');
    fs.writeFileSync(scratch, 'x');
    expect(await isDirty(source, { home })).toBe(true);
    fs.rmSync(scratch);
    expect(await isDirty(source, { home })).toBe(false);
  });

  it('resolves a remote head without cloning', async () => {
    expect(await resolveRemoteHead(source, undefined, { home })).toBe(headCommit);
    expect(await resolveRemoteHead(source, 'main', { home })).toBe(headCommit);
    expect(await resolveRemoteHead(source, 'no-such-ref', { home })).toBeNull();
  });
});

describe('mirrors, worktrees and diffs', () => {
  let mirror: string;

  it('clones a bare mirror from a local path and re-fetches on the second call', async () => {
    mirror = await ensureMirror({ home, source });
    expect(fs.existsSync(path.join(mirror, 'HEAD'))).toBe(true);
    expect(mirror.endsWith('.git')).toBe(true);
    const again = await ensureMirror({ home, source });
    expect(again).toBe(mirror);
  });

  it('never modifies the source checkout', async () => {
    expect(await isDirty(source, { home })).toBe(false);
    expect(readText(path.join(source, 'a.txt'))).toBe('version two\n');
  });

  it('resolves commits from the mirror', async () => {
    expect(await resolveCommit(mirror, undefined, { home })).toBe(headCommit);
    expect(await resolveCommit(mirror, firstCommit, { home })).toBe(firstCommit);
    await expect(resolveCommit(mirror, 'nope', { home })).rejects.toThrow(/rev-parse/);
  });

  it('adds a detached worktree at an exact commit and refuses an existing destination', async () => {
    const dest = path.join(root, 'ws-first');
    await createWorktree({ mirror, commit: firstCommit, dest, home });
    expect(readText(path.join(dest, 'a.txt'))).toBe('version one\n');
    await expect(createWorktree({ mirror, commit: firstCommit, dest, home })).rejects.toThrow(
      /already exists/,
    );
    await removeWorktree({ mirror, dest, home });
  });

  it('collects created, modified, deleted and untracked changes, then leaves the index alone', async () => {
    const dest = path.join(root, 'ws-diff');
    await createWorktree({ mirror, commit: firstCommit, dest, home });
    fs.writeFileSync(path.join(dest, 'a.txt'), 'version one\nplus a line\n');
    fs.writeFileSync(path.join(dest, 'new.txt'), 'brand new\n');
    fs.rmSync(path.join(dest, 'b.txt'));

    const stats = await diffStats(dest, firstCommit, { home });
    const byPath = new Map(stats.files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(['a.txt', 'b.txt', 'new.txt']);
    expect(byPath.get('a.txt')).toMatchObject({ kind: 'modify', linesAdded: 1, linesRemoved: 0 });
    expect(byPath.get('new.txt')).toMatchObject({ kind: 'create', linesAdded: 1, linesRemoved: 0 });
    expect(byPath.get('b.txt')).toMatchObject({ kind: 'delete', linesRemoved: 1 });
    expect(stats.diff).toContain('+++ b/new.txt');
    expect(stats.diff).toContain('plus a line');
    expect(stats.truncated).toBe(false);
    expect(stats.diffBytes).toBe(Buffer.byteLength(stats.diff, 'utf8'));

    // The intent-to-add marks are undone: new.txt is untracked again.
    const status = await git(dest, ['status', '--porcelain']);
    expect(status).toContain('?? new.txt');

    await removeWorktree({ mirror, dest, home });
    expect(fs.existsSync(dest)).toBe(false);
    // Removing twice is not an error.
    await removeWorktree({ mirror, dest, home });
  });

  it('marks binary files without embedding their content', async () => {
    const dest = path.join(root, 'ws-binary');
    await createWorktree({ mirror, commit: firstCommit, dest, home });
    fs.writeFileSync(path.join(dest, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255, 254, 0, 3]));
    const stats = await diffStats(dest, firstCommit, { home });
    const binary = stats.files.find((f) => f.path === 'logo.bin');
    expect(binary).toMatchObject({ binary: true, linesAdded: 0, linesRemoved: 0 });
    expect(stats.diff).toContain('logo.bin');
    await removeWorktree({ mirror, dest, home });
  });

  it('truncates a patch larger than the cap and says so', async () => {
    const dest = path.join(root, 'ws-big');
    await createWorktree({ mirror, commit: firstCommit, dest, home });
    const line = 'x'.repeat(99) + '\n';
    fs.writeFileSync(
      path.join(dest, 'big.txt'),
      line.repeat(Math.ceil((MAX_DIFF_BYTES * 1.2) / line.length)),
    );
    const stats = await diffStats(dest, firstCommit, { home });
    expect(stats.truncated).toBe(true);
    expect(stats.diffBytes).toBeGreaterThan(MAX_DIFF_BYTES);
    expect(stats.diff).toContain('diff truncated at');
    expect(Buffer.byteLength(stats.diff, 'utf8')).toBeLessThan(MAX_DIFF_BYTES + 200);
    await removeWorktree({ mirror, dest, home });
  }, 60_000);

  it('never runs repository hooks (checked against a control run where the hook does fire)', async () => {
    // A hooks directory git will honour: `hooksPath` in the mirror's own config. This is the shape
    // of the threat (a configured hooks directory running code during a checkout Arena triggers).
    const hookDir = path.join(root, 'evil-hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    const hook = path.join(hookDir, 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\ntouch hook-ran.txt\n');
    fs.chmodSync(hook, 0o755);
    await git(mirror, ['config', 'core.hooksPath', toGitPath(hookDir)]);

    // Control: the same git command WITHOUT Arena's flag must run the hook, or this test proves nothing.
    const control = path.join(root, 'ws-hook-control');
    await execa('git', ['-C', mirror, 'worktree', 'add', '--detach', toGitPath(control), firstCommit], {
      reject: false,
    });
    const controlRan = fs.existsSync(path.join(control, 'hook-ran.txt'));
    if (!controlRan) {
      console.log(
        'hook control did not fire in this environment; the suppression assertion below is vacuous',
      );
    }
    expect(controlRan).toBe(true);

    // Guarded: the same operation through Arena must not run it.
    const dest = path.join(root, 'ws-hook-guarded');
    await createWorktree({ mirror, commit: firstCommit, dest, home });
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(path.join(dest, 'hook-ran.txt'))).toBe(false);
    // The empty hooks directory the guard points at lives under ARENA_HOME.
    expect(fs.existsSync(path.join(home, 'git-empty-hooks'))).toBe(true);

    // diffStats runs several git commands in the workspace; none of them may run a hook either.
    fs.writeFileSync(path.join(dest, 'a.txt'), 'changed\n');
    await diffStats(dest, firstCommit, { home });
    expect(fs.existsSync(path.join(dest, 'hook-ran.txt'))).toBe(false);

    await removeWorktree({ mirror, dest, home });
    await execa('git', ['-C', mirror, 'worktree', 'remove', '--force', toGitPath(control)], {
      reject: false,
    });
    await git(mirror, ['config', '--unset', 'core.hooksPath']);
  }, 60_000);
});

describe('empty repositories', () => {
  it('initialises a repository with one empty commit by Arena', async () => {
    const dest = path.join(root, 'greenfield');
    const commit = await initEmptyRepo(dest, { home });
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    const log = await git(dest, ['log', '--format=%H %ae %s']);
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toContain('arena@localhost');
    expect(log).toContain('Empty workspace');
  });

  it('diffs a greenfield workspace against its first commit', async () => {
    const dest = path.join(root, 'greenfield2');
    const commit = await initEmptyRepo(dest, { home });
    fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'src', 'index.js'), 'export const x = 1;\n');
    const stats = await diffStats(dest, commit, { home });
    expect(stats.files).toEqual([
      { path: 'src/index.js', kind: 'create', linesAdded: 1, linesRemoved: 0, binary: false },
    ]);
  });
});
