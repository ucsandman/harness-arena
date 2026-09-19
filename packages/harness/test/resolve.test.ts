import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessRef } from '@harness-arena/protocol';
import { HarnessResolveError, resolveHarness } from '../src/resolve';
import { sourceCacheKey } from '../src/source';
import { parseHarnessSource } from '../src/source';
import type { GitRunner } from '../src/types';
import { createRecordingLogger, makeTempDir, removeDir, writeFiles } from './helpers';

const EXAMPLE_HARNESS = path.resolve(import.meta.dirname, '..', '..', '..', 'examples', 'example-harness');
const FAKE_SHA = 'f'.repeat(40);

function ref(source: string, extra: Partial<HarnessRef> = {}): HarnessRef {
  return { source, trusted: false, ...extra };
}

interface FakeGit {
  git: GitRunner;
  calls: Array<{ args: string[]; cwd?: string }>;
}

function fakeGit(handler?: (args: string[]) => { stdout: string; exitCode: number } | undefined): FakeGit {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const git: GitRunner = async (args, cwd) => {
    calls.push(cwd === undefined ? { args } : { args, cwd });
    const custom = handler?.(args);
    if (custom) return custom;
    if (args.includes('rev-parse')) return { stdout: `${FAKE_SHA}\n`, exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  };
  return { git, calls };
}

describe('resolveHarness: vanilla', () => {
  it('resolves to the agent defaults with no directory', async () => {
    const logger = createRecordingLogger();
    const resolved = await resolveHarness(ref('Vanilla'), {
      home: path.join('unused', 'home'),
      agentId: 'codex',
      logger,
      git: fakeGit().git,
    });
    expect(resolved).toMatchObject({
      name: 'vanilla',
      kind: 'vanilla',
      dir: null,
      commit: null,
      manifest: null,
    });
    expect(resolved.inspection.framework).toBe('unknown');
    expect(resolved.inspection.agents).toEqual(['codex']);
    expect(resolved.inspection.compatibility).toEqual({
      status: 'ready',
      reasons: ['agent defaults, no harness files'],
    });
  });
});

describe('resolveHarness: local', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTempDir('arena-home-');
  });

  afterEach(async () => {
    await removeDir(home);
  });

  it('uses the directory in place and takes the name from the manifest', async () => {
    const { git, calls } = fakeGit();
    const resolved = await resolveHarness(ref(EXAMPLE_HARNESS), {
      home,
      agentId: 'claude-code',
      logger: createRecordingLogger(),
      git,
    });
    expect(resolved.kind).toBe('local');
    expect(resolved.dir).toBe(EXAMPLE_HARNESS);
    expect(resolved.name).toBe('example-harness');
    expect(resolved.commit).toBe(FAKE_SHA);
    expect(resolved.manifest?.agents).toEqual(['claude-code', 'codex']);
    expect(resolved.inspection.compatibility.status).toBe('ready');
    // HEAD is read inside the harness directory, and nothing is cloned
    expect(calls).toEqual([{ args: ['rev-parse', 'HEAD'], cwd: EXAMPLE_HARNESS }]);
    await expect(fs.readdir(path.join(home, 'harnesses'))).rejects.toThrow();
  });

  it('reports a null commit when the directory is not a git repository', async () => {
    const dir = await makeTempDir('arena-harness-plain-');
    try {
      await writeFiles(dir, { 'CLAUDE.md': '# rules\n' });
      const resolved = await resolveHarness(ref(dir), {
        home,
        agentId: 'claude-code',
        logger: createRecordingLogger(),
        git: fakeGit(() => ({ stdout: 'fatal: not a git repository', exitCode: 128 })).git,
      });
      expect(resolved.commit).toBeNull();
      expect(resolved.name).toBe(path.basename(dir));
      expect(resolved.inspection.framework).toBe('claude-code');
    } finally {
      await removeDir(dir);
    }
  });

  it('throws when the local path is not a directory', async () => {
    const missing = path.join(home, 'no-such-harness');
    await expect(
      resolveHarness(ref(missing), {
        home,
        agentId: 'claude-code',
        logger: createRecordingLogger(),
        git: fakeGit().git,
      }),
    ).rejects.toThrow(HarnessResolveError);
  });
});

describe('resolveHarness: github clone', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTempDir('arena-home-');
  });

  afterEach(async () => {
    await removeDir(home);
  });

  it('clones under home/harnesses with hooks disabled and prompts off', async () => {
    const { git, calls } = fakeGit();
    const logger = createRecordingLogger();
    const resolved = await resolveHarness(
      ref('https://github.com/ucsandman/agnostic-ai', { ref: 'v1.0.0' }),
      {
        home,
        agentId: 'claude-code',
        logger,
        git,
      },
    );

    const expectedDir = path.join(
      home,
      'harnesses',
      sourceCacheKey(parseHarnessSource('github:ucsandman/agnostic-ai')),
    );
    expect(resolved.kind).toBe('github');
    expect(resolved.dir).toBe(expectedDir);
    expect(resolved.commit).toBe(FAKE_SHA);
    expect(resolved.name).toBe('ucsandman/agnostic-ai');

    const hooksDir = path.join(home, 'empty-git-hooks');
    expect((await fs.stat(hooksDir)).isDirectory()).toBe(true);
    for (const call of calls) {
      expect(call.args).toContain('-c');
      expect(call.args).toContain(`core.hooksPath=${hooksDir}`);
    }

    const clone = calls.find((c) => c.args.includes('clone'));
    expect(clone?.args).toEqual([
      '-c',
      `core.hooksPath=${hooksDir}`,
      '-c',
      'advice.detachedHead=false',
      'clone',
      '--quiet',
      'https://github.com/ucsandman/agnostic-ai.git',
      expectedDir,
    ]);
    expect(calls.some((c) => c.args.join(' ').includes('checkout --force v1.0.0'))).toBe(true);
    expect(calls.some((c) => c.args.includes('rev-parse'))).toBe(true);
    // nothing from the repository is executed: only git runs
    expect(logger.messages('info')).toContain('cloning harness');
  });

  it('prefers an explicit commit over the ref and retries the checkout against origin', async () => {
    const attempted: string[] = [];
    const { git, calls } = fakeGit((args) => {
      if (args.includes('checkout')) {
        const target = args[args.length - 1] as string;
        attempted.push(target);
        return target.startsWith('origin/')
          ? { stdout: '', exitCode: 0 }
          : { stdout: 'error: pathspec not found', exitCode: 1 };
      }
      return undefined;
    });
    const resolved = await resolveHarness(
      ref('github:o/r', { ref: 'main', commit: 'abcdef1234567890abcdef1234567890abcdef12' }),
      { home, agentId: 'claude-code', logger: createRecordingLogger(), git },
    );
    expect(attempted).toEqual([
      'abcdef1234567890abcdef1234567890abcdef12',
      'origin/abcdef1234567890abcdef1234567890abcdef12',
    ]);
    expect(resolved.commit).toBe(FAKE_SHA);
    expect(calls.some((c) => c.args.includes('clone'))).toBe(true);
  });

  it('fails with a typed error when the clone fails', async () => {
    const { git } = fakeGit((args) =>
      args.includes('clone') ? { stdout: 'fatal: repository not found', exitCode: 128 } : undefined,
    );
    const error = await resolveHarness(ref('github:o/missing'), {
      home,
      agentId: 'claude-code',
      logger: createRecordingLogger(),
      git,
    }).then(
      () => {
        throw new Error('expected a rejection, got a result');
      },
      (e: unknown) => e as HarnessResolveError,
    );
    expect(error).toBeInstanceOf(HarnessResolveError);
    expect(error.code).toBe('clone_failed');
    expect(error.message).toContain('repository not found');
  });

  it('fails with a typed error when the checkout fails twice', async () => {
    const { git } = fakeGit((args) =>
      args.includes('checkout') ? { stdout: 'error: pathspec', exitCode: 1 } : undefined,
    );
    const error = await resolveHarness(ref('github:o/r', { ref: 'nope' }), {
      home,
      agentId: 'claude-code',
      logger: createRecordingLogger(),
      git,
    }).then(
      () => {
        throw new Error('expected a rejection, got a result');
      },
      (e: unknown) => e as HarnessResolveError,
    );
    expect(error.code).toBe('checkout_failed');
  });

  it('reuses an existing clone with a fetch instead of cloning again', async () => {
    const source = parseHarnessSource('github:o/r');
    const dir = path.join(home, 'harnesses', sourceCacheKey(source));
    await writeFiles(dir, {
      'CLAUDE.md': '# from the cached clone\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
    });
    const { git, calls } = fakeGit();
    const resolved = await resolveHarness(ref('github:o/r'), {
      home,
      agentId: 'claude-code',
      logger: createRecordingLogger(),
      git,
    });
    expect(calls.some((c) => c.args.includes('clone'))).toBe(false);
    expect(calls.some((c) => c.args.includes('fetch'))).toBe(true);
    expect(resolved.dir).toBe(dir);
    expect(resolved.inspection.framework).toBe('claude-code');
  });

  it('inspects a subdirectory of the clone when the URL points at a tree path', async () => {
    const source = parseHarnessSource('https://github.com/o/r/tree/main/pkg/harness');
    const dir = path.join(home, 'harnesses', sourceCacheKey(source));
    await writeFiles(dir, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      'CLAUDE.md': '# root, not the harness\n',
      'pkg/harness/AGENTS.md': '# the harness\n',
    });
    const resolved = await resolveHarness(ref('https://github.com/o/r/tree/main/pkg/harness'), {
      home,
      agentId: 'codex',
      logger: createRecordingLogger(),
      git: fakeGit().git,
    });
    expect(resolved.dir).toBe(path.join(dir, 'pkg', 'harness'));
    expect(resolved.inspection.framework).toBe('codex');
    expect(resolved.inspection.applyFiles).toEqual(['AGENTS.md']);
  });
});

describe('resolveHarness: github inspect mode', () => {
  it('reads the repository over the API and never clones', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/repos/o/r')) return new Response(JSON.stringify({ default_branch: 'main' }));
      if (url.includes('/git/trees/main'))
        return new Response(
          JSON.stringify({ truncated: false, tree: [{ path: 'AGENTS.md', type: 'blob' }] }),
        );
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const { git, calls: gitCalls } = fakeGit();
    const resolved = await resolveHarness(ref('https://github.com/o/r'), {
      home: path.join('unused', 'home'),
      agentId: 'codex',
      logger: createRecordingLogger(),
      git,
      mode: 'inspect',
      fetchImpl,
    });
    expect(resolved.dir).toBeNull();
    expect(resolved.kind).toBe('github');
    expect(resolved.name).toBe('o/r');
    expect(resolved.inspection.framework).toBe('codex');
    expect(gitCalls).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  });
});
