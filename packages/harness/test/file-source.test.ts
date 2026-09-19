import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGitHubFileSource,
  createLocalFileSource,
  firstSymlinkComponent,
  GitHubSourceError,
  realpathInside,
  resolveInside,
} from '../src/file-source';
import { jsonResponse, makeTempDir, removeDir, stubFetch, trySymlink, writeFiles } from './helpers';

describe('resolveInside', () => {
  const root = path.resolve('some', 'root');

  it('accepts relative paths inside the root', () => {
    expect(resolveInside(root, 'CLAUDE.md')).toBe(path.join(root, 'CLAUDE.md'));
    expect(resolveInside(root, '.claude/settings.json')).toBe(path.join(root, '.claude', 'settings.json'));
    expect(resolveInside(root, './a/b')).toBe(path.join(root, 'a', 'b'));
  });

  it('refuses traversal, absolute paths and empty input', () => {
    expect(resolveInside(root, '../escape.md')).toBeNull();
    expect(resolveInside(root, 'a/../../escape.md')).toBeNull();
    expect(resolveInside(root, '/etc/passwd')).toBeNull();
    expect(resolveInside(root, 'C:/Windows/system32')).toBeNull();
    expect(resolveInside(root, '')).toBeNull();
  });
});

describe('symlink-aware containment', () => {
  let dir: string;
  let outside: string;

  beforeEach(async () => {
    dir = await makeTempDir('arena-root-');
    outside = await makeTempDir('arena-outside-');
    await writeFiles(dir, { 'real/deep/file.txt': 'inside\n' });
    await writeFiles(outside, { 'CLAUDE.md': '# the victim home\n' });
  });

  afterEach(async () => {
    await removeDir(dir);
    await removeDir(outside);
  });

  it('names the first symlinked component and lets a clean path through', async () => {
    expect(await firstSymlinkComponent(dir, path.join(dir, 'real', 'deep', 'file.txt'))).toBeNull();
    expect(await firstSymlinkComponent(dir, path.join(dir, 'missing', 'file.txt'))).toBeNull();
    expect(await firstSymlinkComponent(dir, dir)).toBeNull();

    const link = path.join(dir, 'link');
    if (!(await trySymlink(outside, link, 'dir'))) return; // platform refuses links and junctions
    expect(await firstSymlinkComponent(dir, path.join(link, 'CLAUDE.md'))).toBe(link);
    expect(await realpathInside(dir, path.join(link, 'CLAUDE.md'))).toBeNull();
    expect(await realpathInside(dir, path.join(dir, 'real', 'deep'))).toBe(
      await fs.realpath(path.join(dir, 'real', 'deep')),
    );
  });

  it('refuses a local file source whose root is a symlink out of the given base', async () => {
    const link = path.join(dir, 'link');
    if (!(await trySymlink(outside, link, 'dir'))) return;

    const guarded = createLocalFileSource(link, { base: dir });
    expect(await guarded.list()).toEqual([]);
    expect(await guarded.listResult()).toEqual({ files: [], truncated: false });
    expect(await guarded.read('CLAUDE.md')).toBeNull();
    expect(await guarded.exists('CLAUDE.md')).toBe(false);

    // a root that really is under the base is unaffected
    const contained = createLocalFileSource(path.join(dir, 'real'), { base: dir });
    expect(await contained.list()).toEqual(['deep/file.txt']);
    // and without a base the caller chose the directory itself, so it is still readable
    expect(await createLocalFileSource(link).list()).toEqual(['CLAUDE.md']);
  });
});

describe('createLocalFileSource', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
    await writeFiles(dir, {
      'CLAUDE.md': '# rules\nline two\n',
      'AGENTS.md': 'agents\n',
      '.claude/settings.json': '{"hooks":{}}',
      '.claude/skills/tests-first/SKILL.md': 'skill\n',
      'src/index.ts': 'export {};\n',
      'node_modules/pkg/index.js': 'ignored\n',
      'dist/out.js': 'ignored\n',
    });
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it('lists files as sorted relative POSIX paths and skips ignored directories', async () => {
    const source = createLocalFileSource(dir);
    const files = await source.list();
    expect(files).toEqual([
      '.claude/settings.json',
      '.claude/skills/tests-first/SKILL.md',
      'AGENTS.md',
      'CLAUDE.md',
      'src/index.ts',
    ]);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('dist/'))).toBe(false);
    expect(await source.listResult()).toEqual({ files, truncated: false });
  });

  it('reads files, honours maxBytes, and refuses paths outside the root', async () => {
    const source = createLocalFileSource(dir);
    expect(await source.read('CLAUDE.md')).toBe('# rules\nline two\n');
    expect(await source.read('CLAUDE.md', 7)).toBe('# rules');
    expect(await source.read('missing.md')).toBeNull();
    expect(await source.read('../outside.md')).toBeNull();
    expect(await source.read('.claude')).toBeNull();
  });

  it('exists() is true for files only', async () => {
    const source = createLocalFileSource(dir);
    expect(await source.exists('CLAUDE.md')).toBe(true);
    expect(await source.exists('.claude/settings.json')).toBe(true);
    expect(await source.exists('.claude')).toBe(false);
    expect(await source.exists('nope.md')).toBe(false);
  });

  it('caps the listing and reports truncated', async () => {
    const source = createLocalFileSource(dir, { maxFiles: 2 });
    const result = await source.listResult();
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('honours a custom ignore list', async () => {
    const source = createLocalFileSource(dir, { ignore: ['.claude', 'node_modules', 'dist'] });
    expect(await source.list()).toEqual(['AGENTS.md', 'CLAUDE.md', 'src/index.ts']);
  });

  it('never lists or follows a symlink', async () => {
    const linked = await trySymlink(path.join(dir, 'CLAUDE.md'), path.join(dir, 'LINKED.md'), 'file');
    const dirLinked = await trySymlink(path.join(dir, '.claude'), path.join(dir, 'linked-dir'), 'dir');
    if (!linked && !dirLinked) return; // platform refuses symlink creation (Windows without the privilege)
    const source = createLocalFileSource(dir);
    const files = await source.list();
    if (linked) {
      expect(files).not.toContain('LINKED.md');
      expect(await source.read('LINKED.md')).toBeNull();
      expect(await source.exists('LINKED.md')).toBe(false);
    }
    if (dirLinked) {
      expect(files.some((f) => f.startsWith('linked-dir/'))).toBe(false);
    }
  });

  it('returns an empty listing for a directory that does not exist', async () => {
    const source = createLocalFileSource(path.join(dir, 'nope'));
    expect(await source.list()).toEqual([]);
    expect(await source.exists('CLAUDE.md')).toBe(false);
  });
});

describe('createGitHubFileSource', () => {
  const tree = (truncated = false) =>
    jsonResponse({
      sha: 'deadbeef',
      truncated,
      tree: [
        { path: 'CLAUDE.md', type: 'blob' },
        { path: '.claude', type: 'tree' },
        { path: '.claude/settings.json', type: 'blob' },
        { path: 'AGENTS.md', type: 'blob' },
      ],
    });

  it('resolves the default branch, lists blobs, and sends the documented headers', async () => {
    const { fetchImpl, calls } = stubFetch((url) => {
      if (url.endsWith('/repos/o/r')) return jsonResponse({ default_branch: 'trunk' });
      if (url.includes('/git/trees/trunk')) return tree();
      throw new Error(`unexpected url ${url}`);
    });
    const source = createGitHubFileSource({ owner: 'o', repo: 'r', fetchImpl });

    expect(await source.list()).toEqual(['.claude/settings.json', 'AGENTS.md', 'CLAUDE.md']);
    expect(await source.resolveRef()).toBe('trunk');
    expect(await source.exists('CLAUDE.md')).toBe(true);
    expect(await source.exists('.claude')).toBe(false);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r');
    expect(calls[1]?.url).toBe('https://api.github.com/repos/o/r/git/trees/trunk?recursive=1');
    expect(calls[1]?.headers['user-agent']).toBe('harness-arena');
    expect(calls[1]?.headers.authorization).toBeUndefined();
    // the default branch and tree are each fetched exactly once
    expect(calls).toHaveLength(2);
  });

  it('uses an explicit ref without asking for the repository', async () => {
    const { fetchImpl, calls } = stubFetch((url) => {
      if (url.includes('/git/trees/v2.0.0')) return tree();
      throw new Error(`unexpected url ${url}`);
    });
    const source = createGitHubFileSource({ owner: 'o', repo: 'r', ref: 'v2.0.0', fetchImpl });
    await source.list();
    expect(calls).toHaveLength(1);
  });

  it('scopes to a subdirectory and strips the prefix', async () => {
    const { fetchImpl } = stubFetch((url) => {
      if (url.endsWith('/repos/o/r')) return jsonResponse({ default_branch: 'main' });
      if (url.includes('/git/trees/'))
        return jsonResponse({
          truncated: false,
          tree: [
            { path: 'pkg/CLAUDE.md', type: 'blob' },
            { path: 'pkg/arena.yaml', type: 'blob' },
            { path: 'other/README.md', type: 'blob' },
          ],
        });
      throw new Error(`unexpected url ${url}`);
    });
    const source = createGitHubFileSource({ owner: 'o', repo: 'r', path: 'pkg', fetchImpl });
    expect(await source.list()).toEqual(['CLAUDE.md', 'arena.yaml']);
  });

  it('surfaces the API truncated flag and its own cap', async () => {
    const truncatedSource = createGitHubFileSource({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      fetchImpl: stubFetch(() => tree(true)).fetchImpl,
    });
    expect((await truncatedSource.listResult()).truncated).toBe(true);

    const cappedSource = createGitHubFileSource({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      maxFiles: 1,
      fetchImpl: stubFetch(() => tree(false)).fetchImpl,
    });
    const capped = await cappedSource.listResult();
    expect(capped.files).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it('reads raw content with the raw Accept header and a token', async () => {
    const { fetchImpl, calls } = stubFetch((url) => {
      if (url.includes('/contents/CLAUDE.md')) return new Response('# harness rules\n', { status: 200 });
      throw new Error(`unexpected url ${url}`);
    });
    const source = createGitHubFileSource({ owner: 'o', repo: 'r', ref: 'main', token: 'ghp_x', fetchImpl });
    expect(await source.read('CLAUDE.md')).toBe('# harness rules\n');
    expect(await source.read('CLAUDE.md', 7)).toBe('# harne');
    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r/contents/CLAUDE.md?ref=main');
    expect(calls[0]?.headers.accept).toBe('application/vnd.github.raw+json');
    expect(calls[0]?.headers.authorization).toBe('Bearer ghp_x');
  });

  it('stops reading the body once maxBytes is reached instead of buffering it all', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 64) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const { fetchImpl } = stubFetch(() => new Response(body, { status: 200 }));
    const source = createGitHubFileSource({ owner: 'o', repo: 'r', ref: 'main', fetchImpl });

    const text = await source.read('huge.md', 2048);
    expect(text).toHaveLength(2048);
    // 64 KB were on offer; reading 2 KB must not have pulled the whole body
    expect(pulls).toBeLessThan(8);
  });

  it('honours a content-length smaller than maxBytes', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response('# harness rules\n', { status: 200, headers: { 'content-length': '7' } }),
    );
    const source = createGitHubFileSource({ owner: 'o', repo: 'r', ref: 'main', fetchImpl });
    expect(await source.read('CLAUDE.md')).toBe('# harne');
  });

  it('returns null for a missing file and refuses traversal without a request', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response('Not Found', { status: 404 }));
    const source = createGitHubFileSource({ owner: 'o', repo: 'r', ref: 'main', fetchImpl });
    expect(await source.read('nope.md')).toBeNull();
    expect(await source.read('../escape.md')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('maps 404 on the tree to a typed not_found error', async () => {
    const { fetchImpl } = stubFetch(() => new Response('Not Found', { status: 404 }));
    const source = createGitHubFileSource({ owner: 'o', repo: 'private', ref: 'main', fetchImpl });
    await expect(source.list()).rejects.toThrow(GitHubSourceError);
    const err = await source.list().then(
      () => {
        throw new Error('expected a rejection, got a result');
      },
      (e: unknown) => e as GitHubSourceError,
    );
    expect(err.kind).toBe('not_found');
    expect(err.status).toBe(404);
    expect(err.message).toContain('private');
  });

  it('maps a 403 rate limit and surfaces the reset time', async () => {
    const resetSeconds = 1_800_000_000;
    const { fetchImpl } = stubFetch(
      () =>
        new Response('rate limited', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) },
        }),
    );
    const source = createGitHubFileSource({ owner: 'o', repo: 'r', ref: 'main', fetchImpl });
    const err = (await source.list().catch((e: unknown) => e)) as GitHubSourceError;
    expect(err).toBeInstanceOf(GitHubSourceError);
    expect(err.kind).toBe('rate_limit');
    expect(err.resetAt).toBe(new Date(resetSeconds * 1000).toISOString());
    expect(err.message).toContain('rate limit');
  });

  it('maps a 403 that is not a rate limit to auth, and other statuses to http', async () => {
    const forbidden = createGitHubFileSource({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      fetchImpl: stubFetch(
        () => new Response('no', { status: 403, headers: { 'x-ratelimit-remaining': '55' } }),
      ).fetchImpl,
    });
    expect(((await forbidden.list().catch((e: unknown) => e)) as GitHubSourceError).kind).toBe('auth');

    const broken = createGitHubFileSource({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      fetchImpl: stubFetch(() => new Response('boom', { status: 500 })).fetchImpl,
    });
    expect(((await broken.list().catch((e: unknown) => e)) as GitHubSourceError).kind).toBe('http');
  });

  it('maps a transport failure to a network error', async () => {
    const source = createGitHubFileSource({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      fetchImpl: (() =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof globalThis.fetch,
    });
    const err = (await source.list().catch((e: unknown) => e)) as GitHubSourceError;
    expect(err.kind).toBe('network');
    expect(err.message).toContain('ENOTFOUND');
  });

  it('rejects a tree response that is not a tree', async () => {
    const source = createGitHubFileSource({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      fetchImpl: stubFetch(() => jsonResponse({ nope: true })).fetchImpl,
    });
    expect(((await source.list().catch((e: unknown) => e)) as GitHubSourceError).kind).toBe(
      'invalid_response',
    );
  });
});

describe('local file source against a real directory tree', () => {
  it('reads the example harness shipped with this package', async () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..', 'examples', 'example-harness');
    await fs.access(root);
    const source = createLocalFileSource(root);
    const files = await source.list();
    expect(files).toContain('CLAUDE.md');
    expect(files).toContain('arena.yaml');
    expect(files).toContain('.claude/skills/tests-first/SKILL.md');
    expect((await source.read('CLAUDE.md'))?.startsWith('# Example harness')).toBe(true);
  });
});
