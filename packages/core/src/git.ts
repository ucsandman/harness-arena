import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { defaultHome, sourceKey } from './store.js';

/**
 * Every git invocation Arena makes goes through here, which guarantees three things:
 *
 *  1. `GIT_TERMINAL_PROMPT=0` — git never blocks a battle waiting for credentials.
 *  2. `-c core.hooksPath=<empty dir>` — repository hooks never execute on the user's machine.
 *  3. `-c protocol.file.allow=always` only for local-path sources, so file:// clones work without
 *     widening the protocol allow-list for remote URLs.
 */

export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** Committer identity for commits Arena creates itself (empty repositories). */
export const ARENA_COMMITTER = { name: 'Arena', email: 'arena@localhost' } as const;

export interface GitOptions {
  /** ARENA_HOME; the empty hooks directory lives under it */
  home?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** allow file:// and local-path transports (local sources only) */
  allowFileProtocol?: boolean;
}

export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DiffFile {
  path: string;
  kind: 'create' | 'modify' | 'delete' | 'rename';
  linesAdded: number;
  linesRemoved: number;
  /** binary files are listed without content */
  binary: boolean;
}

export interface DiffStats {
  files: DiffFile[];
  diff: string;
  diffBytes: number;
  /** the patch exceeded MAX_DIFF_BYTES and was cut */
  truncated: boolean;
}

/** git wants forward slashes even on Windows. */
export function toGitPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** A URL-ish source ("https://…", "git@host:repo") versus a path on this machine. */
export function isLocalSource(source: string): boolean {
  const s = source.trim();
  if (s.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;
  if (/^[\w.-]+@[\w.-]+:/.test(s)) return false;
  return true;
}

function hooksDir(home: string): string {
  const dir = path.join(home, 'git-empty-hooks');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function git(args: string[], opts: GitOptions & { cwd?: string } = {}): Promise<GitRunResult> {
  const home = opts.home ? path.resolve(opts.home) : defaultHome();
  const prefix = ['-c', 'core.hooksPath=' + toGitPath(hooksDir(home))];
  if (process.platform === 'win32') prefix.push('-c', 'core.longpaths=true');
  if (opts.allowFileProtocol) prefix.push('-c', 'protocol.file.allow=always');
  const result = await execa('git', [...prefix, ...args], {
    cwd: opts.cwd,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_OPTIONAL_LOCKS: '0' },
    extendEnv: true,
    reject: false,
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 0,
    cancelSignal: opts.signal,
    stripFinalNewline: false,
  });
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function fail(what: string, r: GitRunResult): never {
  const detail = (r.stderr || r.stdout || '').trim().split('\n').slice(0, 5).join(' / ');
  throw new Error('git ' + what + ' failed (exit ' + r.exitCode + ')' + (detail ? ': ' + detail : ''));
}

export async function gitVersion(opts: GitOptions = {}): Promise<string | null> {
  try {
    const r = await git(['--version'], opts);
    if (r.exitCode !== 0) return null;
    const m = /git version (\S+)/.exec(r.stdout);
    return m ? (m[1] as string) : r.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function isGitRepo(dir: string, opts: GitOptions = {}): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  const r = await git(['rev-parse', '--is-inside-work-tree'], { ...opts, cwd: dir });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

/** Uncommitted changes, including untracked files. */
export async function isDirty(dir: string, opts: GitOptions = {}): Promise<boolean> {
  const r = await git(['status', '--porcelain'], { ...opts, cwd: dir });
  if (r.exitCode !== 0) fail('status', r);
  return r.stdout.trim().length > 0;
}

/** The commit a ref points at on a remote, without cloning. */
export async function resolveRemoteHead(
  source: string,
  ref?: string,
  opts: GitOptions = {},
): Promise<string | null> {
  const target = isLocalSource(source) ? toGitPath(path.resolve(source)) : source;
  const args = ['ls-remote', target];
  if (ref) args.push(ref);
  else args.push('HEAD');
  const r = await git(args, { ...opts, allowFileProtocol: isLocalSource(source) });
  if (r.exitCode !== 0) return null;
  const first = r.stdout.trim().split('\n')[0];
  const sha = first ? first.split(/\s+/)[0] : undefined;
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Bare mirror of a repository under ARENA_HOME/repos. Local sources are cloned too: the user's own
 * checkout is only ever read from.
 */
export async function ensureMirror(args: {
  home: string;
  source: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { home, source } = args;
  const local = isLocalSource(source);
  const target = local ? toGitPath(path.resolve(source)) : source;
  const mirror = path.join(path.resolve(home), 'repos', sourceKey(source) + '.git');
  const opts: GitOptions = { home, signal: args.signal, allowFileProtocol: local };
  if (fs.existsSync(path.join(mirror, 'HEAD'))) {
    const fetched = await git(['fetch', '--prune', '--tags', 'origin'], { ...opts, cwd: mirror });
    if (fetched.exitCode !== 0) fail('fetch', fetched);
    return mirror;
  }
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  fs.rmSync(mirror, { recursive: true, force: true });
  const cloned = await git(['clone', '--mirror', target, toGitPath(mirror)], opts);
  if (cloned.exitCode !== 0) fail('clone --mirror', cloned);
  return mirror;
}

export async function resolveCommit(mirror: string, ref?: string, opts: GitOptions = {}): Promise<string> {
  const target = ref && ref.trim().length > 0 ? ref.trim() : 'HEAD';
  const r = await git(['rev-parse', '--verify', target + '^{commit}'], { ...opts, cwd: mirror });
  if (r.exitCode !== 0) fail('rev-parse ' + target, r);
  const sha = r.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error('git rev-parse returned an unexpected value for ' + target);
  return sha;
}

export async function createWorktree(args: {
  mirror: string;
  commit: string;
  dest: string;
  submodules?: boolean;
  home?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const dest = path.resolve(args.dest);
  if (fs.existsSync(dest)) throw new Error('workspace already exists: ' + dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const opts: GitOptions & { cwd: string } = { home: args.home, signal: args.signal, cwd: args.mirror };
  const added = await git(['worktree', 'add', '--detach', toGitPath(dest), args.commit], opts);
  if (added.exitCode !== 0) fail('worktree add', added);
  if (args.submodules) {
    const sub = await git(['submodule', 'update', '--init', '--recursive'], {
      home: args.home,
      signal: args.signal,
      cwd: dest,
    });
    if (sub.exitCode !== 0) fail('submodule update', sub);
  }
}

/**
 * Remove a worktree and forget it. Tolerates a directory that is already gone. A Windows file lock
 * (an editor, a virus scanner, a lingering child) makes the delete fail on the first try, so the
 * fallback retries; `worktree prune` runs even when the delete gives up, otherwise the mirror keeps a
 * registration for a directory nobody will ever clean up.
 */
export async function removeWorktree(args: { mirror: string; dest: string; home?: string }): Promise<void> {
  const dest = path.resolve(args.dest);
  const opts: GitOptions & { cwd: string } = { home: args.home, cwd: args.mirror };
  try {
    if (fs.existsSync(dest)) {
      const removed = await git(['worktree', 'remove', '--force', toGitPath(dest)], opts);
      if (removed.exitCode !== 0) {
        // Fall back to a plain delete: losing the directory matters more than git's bookkeeping.
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  } finally {
    await git(['worktree', 'prune'], opts);
  }
}

/** A fresh repository with one empty commit, for greenfield ("empty") battles. */
export async function initEmptyRepo(dest: string, opts: GitOptions = {}): Promise<string> {
  const target = path.resolve(dest);
  fs.mkdirSync(target, { recursive: true });
  const init = await git(['-c', 'init.defaultBranch=main', 'init', toGitPath(target)], opts);
  if (init.exitCode !== 0) fail('init', init);
  const commit = await git(
    [
      '-c',
      'user.name=' + ARENA_COMMITTER.name,
      '-c',
      'user.email=' + ARENA_COMMITTER.email,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'Empty workspace',
    ],
    { ...opts, cwd: target },
  );
  if (commit.exitCode !== 0) fail('commit --allow-empty', commit);
  const head = await git(['rev-parse', 'HEAD'], { ...opts, cwd: target });
  if (head.exitCode !== 0) fail('rev-parse HEAD', head);
  return head.stdout.trim();
}

/**
 * Copy a directory of files into `dest` and commit them as the first commit of a new repository.
 * Used by `arena demo` to give the fake runs a real pre-existing project (so diffs and baseline tests
 * are meaningful). Never touches `sourceDir`.
 */
export async function initRepoFromDirectory(
  dest: string,
  sourceDir: string,
  opts: GitOptions = {},
): Promise<string> {
  const target = path.resolve(dest);
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(sourceDir, target, { recursive: true, dereference: true });
  const init = await git(['-c', 'init.defaultBranch=main', 'init', toGitPath(target)], opts);
  if (init.exitCode !== 0) fail('init', init);
  const add = await git(['add', '-A'], { ...opts, cwd: target });
  if (add.exitCode !== 0) fail('add -A', add);
  const commit = await git(
    [
      '-c',
      'user.name=' + ARENA_COMMITTER.name,
      '-c',
      'user.email=' + ARENA_COMMITTER.email,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Initial project',
    ],
    { ...opts, cwd: target },
  );
  if (commit.exitCode !== 0) fail('commit', commit);
  const head = await git(['rev-parse', 'HEAD'], { ...opts, cwd: target });
  if (head.exitCode !== 0) fail('rev-parse HEAD', head);
  return head.stdout.trim();
}

const STATUS_KIND: Record<string, DiffFile['kind']> = { A: 'create', M: 'modify', D: 'delete', R: 'rename' };

/**
 * What the agent changed, relative to the commit the workspace started at. Untracked files are made
 * visible with `add -A --intent-to-add` first, then the index is reset so the workspace is left as
 * the agent left it. Renames are reported as delete + create (`--no-renames`) so the numstat and
 * name-status passes always agree on paths.
 */
export async function diffStats(
  workspace: string,
  startCommit: string | null,
  opts: GitOptions = {},
): Promise<DiffStats> {
  const cwd = path.resolve(workspace);
  const base = startCommit && startCommit.trim().length > 0 ? startCommit.trim() : 'HEAD';
  const run = (args: string[]) => git(args, { ...opts, cwd });

  await run(['add', '-A', '--intent-to-add']);
  try {
    const numstat = await run(['diff', '--no-renames', '--numstat', base, '--']);
    if (numstat.exitCode !== 0) fail('diff --numstat', numstat);
    const nameStatus = await run(['diff', '--no-renames', '--name-status', base, '--']);
    if (nameStatus.exitCode !== 0) fail('diff --name-status', nameStatus);
    const patch = await run(['diff', '--no-renames', base, '--']);
    if (patch.exitCode !== 0) fail('diff', patch);

    const kinds = new Map<string, DiffFile['kind']>();
    for (const line of nameStatus.stdout.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const code = (parts[0] ?? '').charAt(0);
      const file = parts[parts.length - 1];
      if (file) kinds.set(file, STATUS_KIND[code] ?? 'modify');
    }

    const files: DiffFile[] = [];
    for (const line of numstat.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [addedRaw, removedRaw, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (!file) continue;
      const binary = addedRaw === '-' || removedRaw === '-';
      files.push({
        path: file,
        kind: kinds.get(file) ?? 'modify',
        linesAdded: binary ? 0 : Number.parseInt(addedRaw ?? '0', 10) || 0,
        linesRemoved: binary ? 0 : Number.parseInt(removedRaw ?? '0', 10) || 0,
        binary,
      });
    }

    const full = patch.stdout;
    const bytes = Buffer.byteLength(full, 'utf8');
    const truncated = bytes > MAX_DIFF_BYTES;
    const diff = truncated
      ? Buffer.from(full, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8') +
        '\n... diff truncated at ' +
        MAX_DIFF_BYTES +
        ' bytes ...\n'
      : full;
    return { files, diff, diffBytes: bytes, truncated };
  } finally {
    // Undo the intent-to-add marks; the working tree itself is untouched.
    await run(['reset', '--quiet']);
  }
}
