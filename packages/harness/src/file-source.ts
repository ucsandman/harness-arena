import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/**
 * A read-only listing abstraction over a harness repository. Inspection runs against this, so the web
 * server can inspect a GitHub repository over the REST API with exactly the same code the CLI runs over
 * a local checkout, and neither of them ever executes repository code.
 *
 * Paths are relative POSIX paths and always point at files (directories are implied by their contents).
 */
export interface FileSource {
  list(): Promise<string[]>;
  read(path: string, maxBytes?: number): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** listing plus whether it hit a cap; implemented by both built-in sources */
  listResult?(): Promise<ListResult>;
}

export interface ListResult {
  files: string[];
  truncated: boolean;
}

export const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  '.next',
  'coverage',
  'target',
  'vendor',
] as const;
export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_BYTES = 512 * 1024;

export interface LocalFileSourceOptions {
  maxFiles?: number;
  ignore?: readonly string[];
  /**
   * When set, the root must still resolve (`fs.realpath`) inside this directory. A root that is itself
   * a symbolic link out of `base` — a subdirectory link committed in a harness repository, say
   * `link -> ../../../../home/victim` — is refused: the source then lists nothing and reads nothing,
   * so inspection can never walk the link target.
   */
  base?: string;
}

export interface LocalFileSource extends FileSource {
  readonly root: string;
  listResult(): Promise<ListResult>;
}

function sameOrChild(base: string, candidate: string): boolean {
  const b = process.platform === 'win32' ? base.toLowerCase() : base;
  const c = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  if (b === c) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return c.startsWith(prefix);
}

/**
 * Resolve a relative path inside `root`, or null when it is absolute, escapes with `..`, or otherwise
 * lands outside. Used for every read and every copy this package performs.
 */
export function resolveInside(root: string, relative: string): string | null {
  if (typeof relative !== 'string' || relative.length === 0) return null;
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return null;
  if (relative.startsWith('/') || relative.startsWith('\\')) return null;
  const segments = relative.split(/[/\\]+/).filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '..')) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, segments.join(path.sep));
  return sameOrChild(base, abs) ? abs : null;
}

export function toPosix(relative: string): string {
  return relative.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * The first path component at or below `base` on the way to `candidate` that is a symbolic link (or a
 * Windows junction), or null when every component is a real entry. A component that does not exist
 * yet counts as clean: there is nothing to follow.
 *
 * `resolveInside` is textual, so it cannot see a link committed inside a repository. This is the
 * filesystem half of the containment check and must run before anything is read or written.
 */
export async function firstSymlinkComponent(base: string, candidate: string): Promise<string | null> {
  const absBase = path.resolve(base);
  const rel = path.relative(absBase, path.resolve(candidate));
  if (rel.length === 0) return null;
  let current = absBase;
  for (const segment of rel.split(path.sep).filter((s) => s.length > 0)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return current;
    } catch {
      return null; // does not exist: nothing can be followed through it
    }
  }
  return null;
}

/**
 * Resolve both sides with `fs.realpath` and re-assert containment, so a link anywhere along the way
 * cannot smuggle the candidate out of `base`. Returns the real path, or null when either side cannot
 * be resolved or the candidate lands outside.
 */
export async function realpathInside(base: string, candidate: string): Promise<string | null> {
  try {
    const realBase = await fs.realpath(path.resolve(base));
    const realCandidate = await fs.realpath(path.resolve(candidate));
    return sameOrChild(realBase, realCandidate) ? realCandidate : null;
  } catch {
    return null;
  }
}

/**
 * Walks a directory with fs.promises. Symlinks are never listed and never followed. With `opts.base`
 * the root itself is realpath-checked against that base on first use (see `LocalFileSourceOptions`);
 * a root that escapes it yields an empty listing and no reads.
 */
export function createLocalFileSource(root: string, opts: LocalFileSourceOptions = {}): LocalFileSource {
  const absRoot = path.resolve(root);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const ignore = new Set((opts.ignore ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()));
  const base = opts.base === undefined ? null : path.resolve(opts.base);
  let cached: Promise<ListResult> | null = null;
  let containedPromise: Promise<boolean> | null = null;

  /** fail closed: the root must realpath inside the base it was promised to be under */
  function isContained(): Promise<boolean> {
    containedPromise ??=
      base === null ? Promise.resolve(true) : realpathInside(base, absRoot).then((real) => real !== null);
    return containedPromise;
  }

  async function walk(): Promise<ListResult> {
    const files: string[] = [];
    let truncated = false;
    const queue: string[] = [''];

    while (queue.length > 0 && !truncated) {
      const relDir = queue.shift() as string;
      let entries;
      try {
        entries = await fs.readdir(path.join(absRoot, relDir), { withFileTypes: true });
      } catch {
        continue; // unreadable or missing directory: nothing to list
      }
      for (const entry of entries) {
        if (ignore.has(entry.name.toLowerCase())) continue;
        if (entry.isSymbolicLink()) continue;
        const rel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          queue.push(rel);
          continue;
        }
        if (!entry.isFile()) continue;
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        files.push(rel);
      }
    }

    files.sort();
    return { files, truncated };
  }

  function listResult(): Promise<ListResult> {
    cached ??= (async () => ((await isContained()) ? walk() : { files: [], truncated: false }))();
    return cached;
  }

  return {
    root: absRoot,
    listResult,
    async list() {
      return (await listResult()).files;
    },
    async read(relative, maxBytes = DEFAULT_MAX_BYTES) {
      if (!(await isContained())) return null;
      const abs = resolveInside(absRoot, relative);
      if (abs === null) return null;
      try {
        const stat = await fs.lstat(abs);
        if (stat.isSymbolicLink() || !stat.isFile()) return null;
        const handle = await fs.open(abs, 'r');
        try {
          const length = Math.min(stat.size, Math.max(0, maxBytes));
          if (length === 0) return '';
          const buf = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buf, 0, length, 0);
          return buf.subarray(0, bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }
      } catch {
        return null;
      }
    },
    async exists(relative) {
      if (!(await isContained())) return false;
      const abs = resolveInside(absRoot, relative);
      if (abs === null) return false;
      try {
        const stat = await fs.lstat(abs);
        return stat.isFile();
      } catch {
        return false;
      }
    },
  };
}

// ---- GitHub -----------------------------------------------------------------------------------

export type GitHubErrorKind = 'not_found' | 'rate_limit' | 'auth' | 'network' | 'http' | 'invalid_response';

export class GitHubSourceError extends Error {
  readonly kind: GitHubErrorKind;
  readonly status: number | null;
  /** ISO timestamp when the rate limit resets, when GitHub reported one */
  readonly resetAt: string | null;

  constructor(
    kind: GitHubErrorKind,
    message: string,
    opts: { status?: number | null; resetAt?: string | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'GitHubSourceError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.resetAt = opts.resetAt ?? null;
  }
}

export type FetchImpl = typeof globalThis.fetch;

export interface GitHubFileSourceOptions {
  owner: string;
  repo: string;
  ref?: string | null;
  /** inspect a subdirectory of the repository */
  path?: string | null;
  /** optional access token; sent only when present */
  token?: string | null;
  fetchImpl?: FetchImpl;
  maxFiles?: number;
  apiBase?: string;
}

export interface GitHubFileSource extends FileSource {
  listResult(): Promise<ListResult>;
  /** the ref actually used (the repository default branch when none was given) */
  resolveRef(): Promise<string>;
}

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'harness-arena';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read at most `limit` bytes of a response body. `content-length` is honoured when the server sends
 * one, and the body is consumed as a stream that is cancelled the moment the cap is reached, so an
 * oversized (or endless) file is never buffered whole. Truncation is silent, exactly like the local
 * source's `read()`, which also returns the first `maxBytes`.
 */
async function readCapped(res: Response, limit: number): Promise<string> {
  const declaredHeader = res.headers.get('content-length');
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  const cap =
    declared !== null && Number.isFinite(declared) && declared >= 0 ? Math.min(limit, declared) : limit;

  if (cap === 0) {
    await res.body?.cancel().catch(() => undefined);
    return '';
  }

  const body = res.body;
  if (!body) {
    return Buffer.from(await res.arrayBuffer())
      .subarray(0, cap)
      .toString('utf8');
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value as Uint8Array);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, cap).toString('utf8');
}

function encodeRepoPath(p: string): string {
  return p
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/** Reads a GitHub repository through the REST API. Never executes anything. */
export function createGitHubFileSource(opts: GitHubFileSourceOptions): GitHubFileSource {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const apiBase = (opts.apiBase ?? API_BASE).replace(/\/+$/, '');
  const owner = opts.owner;
  const repo = opts.repo;
  const prefix = (opts.path ?? '').replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  let refPromise: Promise<string> | null = null;
  let listPromise: Promise<ListResult> | null = null;

  function headers(accept: string): Record<string, string> {
    const h: Record<string, string> = {
      accept,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };
    if (opts.token) h.authorization = `Bearer ${opts.token}`;
    return h;
  }

  async function request(url: string, accept: string): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(url, { headers: headers(accept) });
    } catch (err) {
      throw new GitHubSourceError('network', `GitHub request failed: ${errMessage(err)}`, { cause: err });
    }
    if (res.ok) return res;

    const status = res.status;
    if (status === 404) {
      throw new GitHubSourceError(
        'not_found',
        `${owner}/${repo}: not found, or private and no token was supplied`,
        { status },
      );
    }
    if (status === 401) {
      throw new GitHubSourceError('auth', 'GitHub rejected the access token (401)', { status });
    }
    if (status === 403 || status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (status === 429 || remaining === '0') {
        const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
        const hint = opts.token ? '' : '; an access token raises the limit';
        throw new GitHubSourceError(
          'rate_limit',
          `GitHub API rate limit exceeded${resetAt ? `; resets at ${resetAt}` : ''}${hint}`,
          { status, resetAt },
        );
      }
      throw new GitHubSourceError('auth', `GitHub denied access to ${owner}/${repo} (403)`, { status });
    }
    throw new GitHubSourceError('http', `GitHub API returned ${status} for ${owner}/${repo}`, { status });
  }

  function resolveRef(): Promise<string> {
    refPromise ??= (async () => {
      if (opts.ref) return opts.ref;
      const res = await request(`${apiBase}/repos/${owner}/${repo}`, 'application/vnd.github+json');
      const body = (await res.json()) as { default_branch?: unknown };
      if (typeof body.default_branch !== 'string' || body.default_branch.length === 0) {
        throw new GitHubSourceError(
          'invalid_response',
          `${owner}/${repo}: the API response has no default_branch`,
        );
      }
      return body.default_branch;
    })();
    return refPromise;
  }

  function listResult(): Promise<ListResult> {
    listPromise ??= (async () => {
      const ref = await resolveRef();
      const url = `${apiBase}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
      const res = await request(url, 'application/vnd.github+json');
      const body = (await res.json()) as { tree?: unknown; truncated?: unknown };
      if (!Array.isArray(body.tree)) {
        throw new GitHubSourceError(
          'invalid_response',
          `${owner}/${repo}: the tree response has no tree array`,
        );
      }
      let truncated = body.truncated === true;
      const files: string[] = [];
      for (const raw of body.tree) {
        const entry = raw as { path?: unknown; type?: unknown };
        if (entry.type !== 'blob' || typeof entry.path !== 'string') continue;
        let rel = entry.path;
        if (prefix.length > 0) {
          if (!rel.startsWith(`${prefix}/`)) continue;
          rel = rel.slice(prefix.length + 1);
        }
        if (rel.length === 0) continue;
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        files.push(rel);
      }
      files.sort();
      return { files, truncated };
    })();
    return listPromise;
  }

  return {
    listResult,
    resolveRef,
    async list() {
      return (await listResult()).files;
    },
    async read(relative, maxBytes = DEFAULT_MAX_BYTES) {
      // same containment rules as the local source, against a synthetic root
      if (resolveInside(path.resolve('/harness-arena-github-root'), relative) === null) return null;
      const ref = await resolveRef();
      const full = prefix.length > 0 ? `${prefix}/${relative}` : relative;
      const url = `${apiBase}/repos/${owner}/${repo}/contents/${encodeRepoPath(full)}?ref=${encodeURIComponent(ref)}`;
      let res: Response;
      try {
        res = await request(url, 'application/vnd.github.raw+json');
      } catch (err) {
        if (err instanceof GitHubSourceError && err.kind === 'not_found') return null;
        throw err;
      }
      return readCapped(res, Math.max(0, maxBytes));
    },
    async exists(relative) {
      const posix = relative.replace(/\\/g, '/');
      return (await listResult()).files.includes(posix);
    },
  };
}
