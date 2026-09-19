import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { HarnessInspection, HarnessManifest, HarnessRef, HarnessSource } from '@harness-arena/protocol';
import {
  createGitHubFileSource,
  createLocalFileSource,
  resolveInside,
  type FetchImpl,
  type FileSource,
} from './file-source.js';
import { inspectHarness, vanillaInspection } from './inspect.js';
import { cloneUrl, harnessDisplayName, parseHarnessSource, sourceCacheKey } from './source.js';
import type { GitRunner, Logger } from './types.js';

/**
 * Turning a HarnessRef into something Arena can apply: a checkout (or nothing, for vanilla), the exact
 * commit, the manifest, and the inspection. No repository code is ever executed here; git is invoked
 * with argument arrays, with hooks disabled and credential prompts turned off.
 */

export interface ResolvedHarness {
  name: string;
  kind: 'vanilla' | 'github' | 'git' | 'local';
  source: HarnessSource;
  /** absolute path of the harness checkout; null for vanilla (and for API-only inspection) */
  dir: string | null;
  commit: string | null;
  manifest: HarnessManifest | null;
  inspection: HarnessInspection;
}

export interface ResolveOptions {
  /** ARENA_HOME; clones live under <home>/harnesses/<cacheKey> */
  home: string;
  agentId: string;
  logger: Logger;
  /** injected so tests never spawn git; defaults to execa */
  git?: GitRunner;
  /** only used by mode 'inspect' (GitHub REST API) */
  fetchImpl?: FetchImpl;
  token?: string | null;
  /** 'clone' (default) checks the harness out locally; 'inspect' reads a GitHub harness over the API */
  mode?: 'clone' | 'inspect';
  now?: () => Date;
}

export type HarnessResolveErrorCode =
  'harness_not_found' | 'clone_failed' | 'checkout_failed' | 'unsupported_source' | 'path_escape';

export class HarnessResolveError extends Error {
  readonly code: HarnessResolveErrorCode;
  constructor(code: HarnessResolveErrorCode, message: string) {
    super(message);
    this.name = 'HarnessResolveError';
    this.code = code;
  }
}

const SHA_RE = /^[0-9a-f]{7,40}$/;

function shaOrNull(stdout: string): string | null {
  const first = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return SHA_RE.test(first) ? first : null;
}

/** The default git invoker: execa with argument arrays, no shell, no credential prompts. */
export function createExecaGitRunner(timeoutMs = 10 * 60_000): GitRunner {
  return async (args, cwd) => {
    try {
      const result = await execa('git', args, {
        cwd,
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          GCM_INTERACTIVE: 'never',
        },
        reject: false,
        timeout: timeoutMs,
        stripFinalNewline: true,
      });
      const out = [String(result.stdout ?? ''), String(result.stderr ?? '')]
        .filter((s) => s.length > 0)
        .join('\n');
      return { stdout: out, exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1 };
    } catch (err) {
      return { stdout: err instanceof Error ? err.message : String(err), exitCode: 1 };
    }
  };
}

function manifestPathOf(ref: HarnessRef): string | null {
  return typeof ref.manifestPath === 'string' && ref.manifestPath.length > 0 ? ref.manifestPath : null;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function finish(
  kind: ResolvedHarness['kind'],
  source: HarnessSource,
  files: FileSource,
  dir: string | null,
  commit: string | null,
  ref: HarnessRef,
  opts: ResolveOptions,
): Promise<ResolvedHarness> {
  const inspection = await inspectHarness(source, files, {
    commit,
    now: opts.now,
    manifestPath: manifestPathOf(ref),
  });
  const manifest = inspection.manifest.manifest;
  return {
    name: manifest?.name ?? harnessDisplayName(source),
    kind,
    source,
    dir,
    commit,
    manifest,
    inspection,
  };
}

export async function resolveHarness(ref: HarnessRef, opts: ResolveOptions): Promise<ResolvedHarness> {
  const logger = opts.logger.child({ component: 'harness/resolve' });
  const source = parseHarnessSource(ref.source);

  if (source.kind === 'vanilla') {
    logger.debug('vanilla harness: agent defaults only', { agent: opts.agentId });
    return {
      name: 'vanilla',
      kind: 'vanilla',
      source,
      dir: null,
      commit: null,
      manifest: null,
      inspection: { ...vanillaInspection(source, { now: opts.now }), agents: [opts.agentId] },
    };
  }

  if (source.kind === 'local') {
    const dir = path.resolve(source.path);
    if (!(await isDirectory(dir))) {
      throw new HarnessResolveError('harness_not_found', `harness path is not a directory: ${dir}`);
    }
    const git = opts.git ?? createExecaGitRunner();
    const head = await git(['rev-parse', 'HEAD'], dir);
    const commit = head.exitCode === 0 ? shaOrNull(head.stdout) : null;
    logger.debug('local harness used in place (read-only)', { dir, commit });
    return finish('local', source, createLocalFileSource(dir), dir, commit, ref, opts);
  }

  if (source.kind === 'github' && opts.mode === 'inspect') {
    const files = createGitHubFileSource({
      owner: source.owner,
      repo: source.repo,
      ref: ref.ref ?? source.ref ?? null,
      path: source.path,
      token: opts.token ?? null,
      fetchImpl: opts.fetchImpl,
    });
    logger.debug('inspecting GitHub harness over the REST API (no checkout)', {
      owner: source.owner,
      repo: source.repo,
    });
    return finish('github', source, files, null, ref.commit ?? null, ref, opts);
  }

  const url = cloneUrl(source);
  if (url === null)
    throw new HarnessResolveError('unsupported_source', `cannot clone source kind ${source.kind}`);

  const cloneDir = path.join(path.resolve(opts.home), 'harnesses', sourceCacheKey(source));
  const hooksDir = path.join(path.resolve(opts.home), 'empty-git-hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.mkdir(path.dirname(cloneDir), { recursive: true });

  const git = opts.git ?? createExecaGitRunner();
  // hooks disabled for every invocation: a harness repository must never run code during resolution
  const base = ['-c', `core.hooksPath=${hooksDir}`, '-c', 'advice.detachedHead=false'];

  if (await isDirectory(path.join(cloneDir, '.git'))) {
    logger.debug('reusing harness clone', { dir: cloneDir });
    const fetched = await git([...base, '-C', cloneDir, 'fetch', '--tags', '--prune', 'origin']);
    if (fetched.exitCode !== 0) {
      logger.warn('git fetch failed; continuing with the existing checkout', { exitCode: fetched.exitCode });
    }
  } else {
    logger.info('cloning harness', { url, dir: cloneDir });
    const cloned = await git([...base, 'clone', '--quiet', url, cloneDir]);
    if (cloned.exitCode !== 0) {
      throw new HarnessResolveError('clone_failed', `git clone failed for ${url}: ${cloned.stdout}`);
    }
  }

  const target = ref.commit ?? ref.ref ?? source.ref ?? null;
  if (target !== null && target.length > 0) {
    const checkout = await git([...base, '-C', cloneDir, 'checkout', '--force', target]);
    if (checkout.exitCode !== 0) {
      const retry = await git([...base, '-C', cloneDir, 'checkout', '--force', `origin/${target}`]);
      if (retry.exitCode !== 0) {
        throw new HarnessResolveError(
          'checkout_failed',
          `git checkout ${target} failed in ${cloneDir}: ${checkout.stdout}`,
        );
      }
    }
  }

  const head = await git([...base, '-C', cloneDir, 'rev-parse', 'HEAD']);
  const commit = head.exitCode === 0 ? shaOrNull(head.stdout) : null;

  let rootDir = cloneDir;
  if (source.kind === 'github' && source.path) {
    const inside = resolveInside(cloneDir, source.path);
    if (inside === null) {
      throw new HarnessResolveError(
        'path_escape',
        `harness subdirectory escapes the checkout: ${source.path}`,
      );
    }
    rootDir = inside;
  }

  return finish(source.kind, source, createLocalFileSource(rootDir), rootDir, commit, ref, opts);
}
