import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import type { HarnessSource } from '@harness-arena/protocol';

/** Parsing of the `harness.source` string: `vanilla`, a GitHub URL, another git URL, or a local path. */

export interface GitHubUrlParts {
  owner: string;
  repo: string;
  /** branch, tag or commit taken from a /tree/ or /blob/ URL */
  ref: string | null;
  /** subdirectory inside the repository (a /blob/ URL contributes its parent directory) */
  path: string | null;
  /** canonical https URL of the repository root */
  url: string;
}

export class HarnessSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessSourceError';
  }
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const GIT_URL_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:']);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** user@host:path (scp-like git syntax) */
const SCP_RE = /^([^@\s/\\]+)@([^:\s/\\]+):(.+)$/;

function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('..');
}

function stripDotGit(repo: string): string {
  return repo.replace(/\.git$/i, '');
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function partsFromPath(rawPath: string): GitHubUrlParts | null {
  const segments = rawPath
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;

  const owner = segments[0] as string;
  const repo = stripDotGit(segments[1] as string);
  if (!isValidName(owner) || !isValidName(repo)) return null;

  const url = `https://github.com/${owner}/${repo}`;
  if (segments.length === 2) return { owner, repo, ref: null, path: null, url };

  const kind = (segments[2] as string).toLowerCase();
  if (kind !== 'tree' && kind !== 'blob') return null;

  const ref = segments[3];
  if (!ref) return null;

  const rest = segments.slice(4);
  if (rest.some((s) => s === '..' || s === '.')) return null;
  let subPath = rest.join('/');
  if (kind === 'blob') {
    const cut = subPath.lastIndexOf('/');
    subPath = cut === -1 ? '' : subPath.slice(0, cut);
  }
  return { owner, repo, ref, path: subPath.length > 0 ? subPath : null, url };
}

/**
 * Parse a GitHub repository reference. Returns null for anything that is not GitHub, is malformed,
 * or carries credentials in the URL (`https://token@github.com/...`).
 */
export function parseGitHubUrl(input: string): GitHubUrlParts | null {
  const raw = (input ?? '').trim();
  if (raw.length === 0) return null;
  // a `..` segment is never legitimate here, and URL normalization would silently swallow it
  if (/(^|[/:])\.\.([/]|$)/.test(raw)) return null;

  const shorthand = /^github:\/{0,2}([^\s?#]+)$/i.exec(raw);
  if (shorthand) {
    const decoded = safeDecode(shorthand[1] as string);
    return decoded === null ? null : partsFromPath(decoded);
  }

  const scp = SCP_RE.exec(raw);
  if (scp) {
    const user = (scp[1] as string).toLowerCase();
    const host = (scp[2] as string).toLowerCase();
    // only the conventional `git` ssh user; anything else is a credential we refuse to carry
    if (user !== 'git') return null;
    if (!GITHUB_HOSTS.has(host)) return null;
    const decoded = safeDecode(scp[3] as string);
    return decoded === null ? null : partsFromPath(decoded);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const protocol = url.protocol.toLowerCase();
  if (!GIT_URL_PROTOCOLS.has(protocol)) return null;
  // a password is always a credential; a username is too, except the conventional ssh `git` user
  if (url.password.length > 0) return null;
  const sshGitUser = (protocol === 'ssh:' || protocol === 'git:') && url.username.toLowerCase() === 'git';
  if (url.username.length > 0 && !sshGitUser) return null;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
  const decoded = safeDecode(url.pathname);
  return decoded === null ? null : partsFromPath(decoded);
}

function looksLikeGitUrl(raw: string): boolean {
  if (SCP_RE.test(raw)) return true;
  try {
    return GIT_URL_PROTOCOLS.has(new URL(raw).protocol.toLowerCase());
  } catch {
    return false;
  }
}

function assertNoCredentials(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return; // scp syntax carries an ssh user, not a credential
  }
  const proto = url.protocol.toLowerCase();
  const httpUserInfo = (proto === 'https:' || proto === 'http:') && url.username.length > 0;
  if (httpUserInfo || url.password.length > 0) {
    throw new HarnessSourceError(
      'harness URL carries credentials; use an authenticated git helper or a public URL instead',
    );
  }
}

/** Classify a harness source string. Local paths are resolved to absolute. */
export function parseHarnessSource(input: string): HarnessSource {
  const raw = (input ?? '').trim();
  if (raw.length === 0) throw new HarnessSourceError('harness source is empty');

  if (raw.toLowerCase() === 'vanilla') return { kind: 'vanilla' };
  const vanilla = /^vanilla:(.*)$/i.exec(raw);
  if (vanilla) {
    const agent = (vanilla[1] as string).trim().toLowerCase();
    return agent.length > 0 ? { kind: 'vanilla', agent } : { kind: 'vanilla' };
  }

  const gh = parseGitHubUrl(raw);
  if (gh) {
    return { kind: 'github', url: gh.url, owner: gh.owner, repo: gh.repo, ref: gh.ref, path: gh.path };
  }

  if (looksLikeGitUrl(raw)) {
    assertNoCredentials(raw);
    return { kind: 'git', url: raw, ref: null };
  }

  return { kind: 'local', path: path.resolve(raw) };
}

/** Short human label: `owner/repo`, `vanilla`, or the last path segment. */
export function harnessDisplayName(source: HarnessSource): string {
  switch (source.kind) {
    case 'vanilla':
      return 'vanilla';
    case 'github':
      return `${source.owner}/${source.repo}`;
    case 'git': {
      const trimmed = stripDotGit(source.url.replace(/[/\\]+$/, ''));
      const segments = trimmed.split(/[/:]/).filter((s) => s.length > 0);
      return segments[segments.length - 1] ?? trimmed;
    }
    case 'local': {
      const trimmed = source.path.replace(/[/\\]+$/, '');
      return path.basename(trimmed) || trimmed;
    }
  }
}

/** Stable, filesystem-safe identity of a source; used as the clone directory name. */
export function normalizeSourceKey(source: HarnessSource): string {
  switch (source.kind) {
    case 'vanilla':
      return `vanilla:${source.agent ?? ''}`;
    case 'github':
      return `github:${source.owner.toLowerCase()}/${source.repo.toLowerCase()}@${source.ref ?? ''}:${source.path ?? ''}`;
    case 'git':
      return `git:${source.url}@${source.ref ?? ''}`;
    case 'local': {
      const resolved = path.resolve(source.path);
      return `local:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
    }
  }
}

export function sourceCacheKey(source: HarnessSource): string {
  return createHash('sha1').update(normalizeSourceKey(source), 'utf8').digest('hex');
}

/** The URL Arena clones for a remote source. */
export function cloneUrl(source: HarnessSource): string | null {
  if (source.kind === 'github') return `https://github.com/${source.owner}/${source.repo}.git`;
  if (source.kind === 'git') return source.url;
  return null;
}
