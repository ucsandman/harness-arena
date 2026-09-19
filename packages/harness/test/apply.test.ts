import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyHarness,
  describeExecution,
  HarnessApplyError,
  HarnessTrustRequiredError,
  resolveAgentConfig,
} from '../src/apply';
import { resolveHarness, type ResolvedHarness } from '../src/resolve';
import type { ProcessRunner, ProcessRunResult } from '../src/types';
import { createRecordingLogger, makeTempDir, removeDir, trySymlink, writeFiles } from './helpers';

const OTHER_PLATFORM = process.platform === 'darwin' ? 'linux' : 'darwin';

interface RunnerCall {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  stdin: string | null;
}

function fakeRunner(overrides: Partial<ProcessRunResult> = {}): {
  runner: ProcessRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: ProcessRunner = {
    async run(opts) {
      calls.push({
        command: opts.command,
        args: [...opts.args],
        cwd: opts.cwd,
        env: { ...opts.env },
        timeoutMs: opts.timeoutMs,
        stdin: opts.stdin,
      });
      opts.onStdoutLine('fake runner output');
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        outputBytes: 18,
        truncated: false,
        durationMs: 5,
        spawnError: null,
        ...overrides,
      };
    },
  };
  return { runner, calls };
}

describe('applyHarness', () => {
  const tempDirs: string[] = [];
  let home: string;
  let workspace: string;
  let logger: ReturnType<typeof createRecordingLogger>;

  async function tempDir(prefix: string): Promise<string> {
    const dir = await makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    home = await tempDir('arena-home-');
    workspace = await tempDir('arena-workspace-');
    logger = createRecordingLogger();
  });

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await removeDir(dir);
  });

  async function makeHarness(files: Record<string, string>): Promise<ResolvedHarness> {
    const dir = await tempDir('arena-harness-');
    await writeFiles(dir, files);
    return resolveHarness(
      { source: dir, trusted: false },
      {
        home,
        agentId: 'claude-code',
        logger: createRecordingLogger(),
        git: async () => ({ stdout: 'fatal: not a git repository', exitCode: 128 }),
      },
    );
  }

  const baseFiles = {
    'CLAUDE.md': '# harness rules\n',
    'AGENTS.md': '# harness agents\n',
    '.claude/settings.json': '{"hooks":{}}',
    '.claude/agents/reviewer.md': '# reviewer\n',
  };

  it('copies declared files and directories into the workspace', async () => {
    const harness = await makeHarness({
      ...baseFiles,
      'arena.yaml':
        'arena: 1\nname: copier\nfiles:\n  - CLAUDE.md\n  - .claude\n  - AGENTS.md\n  - ../escape.md\n  - /etc/passwd\n  - missing.md\n',
    });
    const { runner } = fakeRunner();
    const result = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner,
      env: {},
      logger,
    });

    expect([...result.appliedFiles].sort()).toEqual([
      '.claude/agents/reviewer.md',
      '.claude/settings.json',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
    expect(await fs.readFile(path.join(workspace, 'CLAUDE.md'), 'utf8')).toBe('# harness rules\n');
    expect(await fs.readFile(path.join(workspace, '.claude', 'agents', 'reviewer.md'), 'utf8')).toBe(
      '# reviewer\n',
    );
    expect(result.executedCommands).toEqual([]);

    // the traversing and absolute entries were refused, and nothing landed beside the workspace
    const refusals = logger.records.filter((r) => r.msg.startsWith('refused harness path'));
    expect(refusals).toHaveLength(2);
    await expect(fs.access(path.join(path.dirname(workspace), 'escape.md'))).rejects.toThrow();
  });

  it('moves a colliding root CLAUDE.md into .claude/CLAUDE.md and records the choice', async () => {
    await writeFiles(workspace, { 'CLAUDE.md': '# the repository own rules\n' });
    const harness = await makeHarness({
      ...baseFiles,
      'arena.yaml': 'arena: 1\nname: collider\nfiles:\n  - CLAUDE.md\n',
    });
    const result = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner: fakeRunner().runner,
      env: {},
      logger,
    });

    expect(result.appliedFiles).toEqual(['.claude/CLAUDE.md (from CLAUDE.md)']);
    expect(await fs.readFile(path.join(workspace, 'CLAUDE.md'), 'utf8')).toBe('# the repository own rules\n');
    expect(await fs.readFile(path.join(workspace, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# harness rules\n');
  });

  it('keeps the repository version of any other colliding file', async () => {
    await writeFiles(workspace, {
      'AGENTS.md': '# the repository agents\n',
      '.claude/settings.json': '{"repo":true}',
    });
    const harness = await makeHarness({
      ...baseFiles,
      'arena.yaml': 'arena: 1\nname: collider\nfiles:\n  - AGENTS.md\n  - .claude\n',
    });
    const result = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner: fakeRunner().runner,
      env: {},
      logger,
    });

    expect(result.appliedFiles).toEqual(['.claude/agents/reviewer.md']);
    expect(await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe('# the repository agents\n');
    expect(await fs.readFile(path.join(workspace, '.claude', 'settings.json'), 'utf8')).toBe('{"repo":true}');
    expect(logger.messages('warn')).toContain(
      'kept the repository version of a file the harness also provides',
    );
  });

  it('never copies a symlink', async () => {
    const harness = await makeHarness({
      ...baseFiles,
      'arena.yaml': 'arena: 1\nname: linky\nfiles:\n  - CLAUDE.md\n  - linked.md\n  - .claude\n',
    });
    const harnessDir = harness.dir as string;
    const madeFile = await trySymlink(
      path.join(harnessDir, 'CLAUDE.md'),
      path.join(harnessDir, 'linked.md'),
      'file',
    );
    const madeInner = await trySymlink(
      path.join(harnessDir, 'AGENTS.md'),
      path.join(harnessDir, '.claude', 'linked-inner.md'),
      'file',
    );
    if (!madeFile && !madeInner) return; // platform refuses symlink creation

    const result = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner: fakeRunner().runner,
      env: {},
      logger,
    });
    expect(result.appliedFiles).not.toContain('linked.md');
    expect(result.appliedFiles).not.toContain('.claude/linked-inner.md');
    expect(logger.messages('warn').some((m) => m.includes('symlink'))).toBe(true);
    await expect(fs.access(path.join(workspace, 'linked.md'))).rejects.toThrow();
  });

  it('applies into the manifest target directory', async () => {
    const harness = await makeHarness({
      ...baseFiles,
      'arena.yaml': 'arena: 1\nname: targeted\ntarget: nested/dir\nfiles:\n  - CLAUDE.md\n',
    });
    const result = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner: fakeRunner().runner,
      env: {},
      logger,
    });
    expect(result.appliedFiles).toEqual(['nested/dir/CLAUDE.md']);
    expect(await fs.readFile(path.join(workspace, 'nested', 'dir', 'CLAUDE.md'), 'utf8')).toBe(
      '# harness rules\n',
    );
  });

  it('refuses a manifest target that escapes the workspace', async () => {
    const harness = await makeHarness({
      'CLAUDE.md': '# harness rules\n',
      'arena.yaml': 'arena: 1\nname: escaper\ntarget: ../outside\nfiles:\n  - CLAUDE.md\n',
    });
    const error = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner: fakeRunner().runner,
      env: {},
      logger,
    }).then(
      () => {
        throw new Error('expected a rejection, got a result');
      },
      (e: unknown) => e as HarnessApplyError,
    );
    expect(error).toBeInstanceOf(HarnessApplyError);
    expect(error.code).toBe('workspace_escape');
  });

  it('refuses to run commands until the harness is trusted, and copies nothing first', async () => {
    const harness = await makeHarness({
      ...baseFiles,
      'arena.yaml':
        'arena: 1\nname: commander\nfiles:\n  - CLAUDE.md\ninstall:\n  command: npm ci\nprepare:\n  command: node scripts/prepare.mjs\n',
    });
    const { runner, calls } = fakeRunner();
    const error = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner,
      env: {},
      logger,
    }).then(
      () => {
        throw new Error('expected a rejection, got a result');
      },
      (e: unknown) => e as HarnessTrustRequiredError,
    );

    expect(error).toBeInstanceOf(HarnessTrustRequiredError);
    expect(error.commands).toEqual(['npm ci', 'node scripts/prepare.mjs']);
    expect(error.message).toContain('npm ci');
    expect(calls).toEqual([]);
    expect(await fs.readdir(workspace)).toEqual([]);
  });

  it('runs install in the harness directory and prepare in the workspace once trusted', async () => {
    const harness = await makeHarness({
      ...baseFiles,
      'arena.yaml':
        'arena: 1\nname: commander\nfiles:\n  - CLAUDE.md\ninstall:\n  command: npm ci\n  timeoutMs: 60000\nprepare:\n  command: node scripts/prepare.mjs\ncleanup:\n  command: node scripts/cleanup.mjs\n',
    });
    const { runner, calls } = fakeRunner();
    const result = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: true,
      runner,
      env: { PATH: process.env.PATH ?? '' },
      logger,
    });

    expect(result.executedCommands).toEqual(['npm ci', 'node scripts/prepare.mjs']);
    expect(calls).toHaveLength(2);
    const [install, prepare] = calls as [RunnerCall, RunnerCall];
    if (process.platform === 'win32') {
      expect(install.command).toBe('cmd.exe');
      expect(install.args).toEqual(['/d', '/s', '/c', 'npm ci']);
    } else {
      expect(install.command).toBe('sh');
      expect(install.args).toEqual(['-c', 'npm ci']);
    }
    expect(install.cwd).toBe(harness.dir);
    expect(install.timeoutMs).toBe(60_000);
    expect(install.stdin).toBeNull();
    expect(prepare.cwd).toBe(workspace);
    expect(prepare.args[prepare.args.length - 1]).toBe('node scripts/prepare.mjs');
    expect(install.env).toMatchObject({
      ARENA_WORKSPACE: workspace,
      ARENA_HARNESS_DIR: harness.dir as string,
      ARENA_AGENT: 'claude-code',
      PATH: process.env.PATH ?? '',
    });
    // cleanup is disclosed but not run by applyHarness
    expect(result.executedCommands).not.toContain('node scripts/cleanup.mjs');
    expect(result.appliedFiles).toEqual(['CLAUDE.md']);
  });

  it('turns a failing command into a typed error', async () => {
    const harness = await makeHarness({
      'CLAUDE.md': '# harness rules\n',
      'arena.yaml': 'arena: 1\nname: failer\ninstall:\n  command: exit 1\n',
    });
    const failing = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: true,
      runner: fakeRunner({ exitCode: 1 }).runner,
      env: {},
      logger,
    }).then(
      () => {
        throw new Error('expected a rejection, got a result');
      },
      (e: unknown) => e as HarnessApplyError,
    );
    expect(failing.code).toBe('command_failed');
    expect(failing.message).toContain('exited 1');

    const spawnFailed = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: true,
      runner: fakeRunner({ exitCode: null, spawnError: 'ENOENT' }).runner,
      env: {},
      logger,
    }).then(
      () => {
        throw new Error('expected a rejection, got a result');
      },
      (e: unknown) => e as HarnessApplyError,
    );
    expect(spawnFailed.message).toContain('could not start');

    const timedOut = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: true,
      runner: fakeRunner({ exitCode: null, timedOut: true }).runner,
      env: {},
      logger,
    }).then(
      () => {
        throw new Error('expected a rejection, got a result');
      },
      (e: unknown) => e as HarnessApplyError,
    );
    expect(timedOut.message).toContain('timed out');
  });

  it('skips a command gated to another platform, so no trust is needed', async () => {
    const harness = await makeHarness({
      'CLAUDE.md': '# harness rules\n',
      'arena.yaml': `arena: 1\nname: gated\nfiles:\n  - CLAUDE.md\ninstall:\n  command: brew install jq\n  platforms:\n    - ${OTHER_PLATFORM}\n`,
    });
    const { runner, calls } = fakeRunner();
    const result = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner,
      env: {},
      logger,
    });
    expect(result.executedCommands).toEqual([]);
    expect(calls).toEqual([]);
    expect(describeExecution(harness).commands).toEqual([]);
  });

  it('resolves agentConfig file references to absolute paths under the harness', async () => {
    const harness = await makeHarness({
      ...baseFiles,
      'mcp.json': '{"mcpServers":{}}',
      'arena.yaml':
        'arena: 1\nname: configured\nfiles:\n  - CLAUDE.md\nagentConfig:\n  claude-code:\n    args:\n      - --verbose\n    settings: .claude/settings.json\n    mcpConfig: mcp.json\n    systemPromptAppend: AGENTS.md\n    model: sonnet\n  codex:\n    systemPromptAppend: Follow AGENTS.md exactly.\n',
    });
    const dir = harness.dir as string;

    const result = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner: fakeRunner().runner,
      env: {},
      logger,
    });
    expect(result.agentConfig).toEqual({
      args: ['--verbose'],
      settings: path.join(dir, '.claude', 'settings.json'),
      mcpConfig: path.join(dir, 'mcp.json'),
      systemPromptAppend: path.join(dir, 'AGENTS.md'),
      model: 'sonnet',
    });

    // inline text is left alone, and an agent with no entry gets null
    expect(resolveAgentConfig(harness, 'codex')?.systemPromptAppend).toBe('Follow AGENTS.md exactly.');
    expect(resolveAgentConfig(harness, 'gemini-cli')).toBeNull();
  });

  it('refuses an agentConfig path that escapes the harness directory', async () => {
    const harness = await makeHarness({
      'CLAUDE.md': '# harness rules\n',
      'arena.yaml':
        'arena: 1\nname: sneaky\nagentConfig:\n  claude-code:\n    settings: ../../secrets.json\n',
    });
    const error = (() => {
      try {
        resolveAgentConfig(harness, 'claude-code');
        return null;
      } catch (e: unknown) {
        return e as HarnessApplyError;
      }
    })();
    expect(error).toBeInstanceOf(HarnessApplyError);
    expect(error?.code).toBe('agent_config');
  });

  it('applies auto-detected files when the harness has no manifest', async () => {
    const harness = await makeHarness({ ...baseFiles, 'GEMINI.md': '# gemini\n' });
    const result = await applyHarness(harness, {
      workspace,
      agentId: 'claude-code',
      trusted: false,
      runner: fakeRunner().runner,
      env: {},
      logger,
    });
    expect(harness.manifest).toBeNull();
    expect([...result.appliedFiles].sort()).toEqual([
      '.claude/agents/reviewer.md',
      '.claude/settings.json',
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
    ]);
    expect(result.agentConfig).toBeNull();
  });

  it('applies nothing for a vanilla harness', async () => {
    const vanilla = await resolveHarness(
      { source: 'vanilla', trusted: false },
      {
        home,
        agentId: 'codex',
        logger: createRecordingLogger(),
        git: async () => ({ stdout: '', exitCode: 0 }),
      },
    );
    const result = await applyHarness(vanilla, {
      workspace,
      agentId: 'codex',
      trusted: false,
      runner: fakeRunner().runner,
      env: {},
      logger,
    });
    expect(result).toEqual({ appliedFiles: [], executedCommands: [], agentConfig: null });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
});

describe('describeExecution', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await removeDir(dir);
  });

  it('lists the commands verbatim and the files that would be applied', async () => {
    const dir = await makeTempDir('arena-harness-');
    tempDirs.push(dir);
    const home = await makeTempDir('arena-home-');
    tempDirs.push(home);
    await writeFiles(dir, {
      'CLAUDE.md': '# rules\n',
      'arena.yaml':
        'arena: 1\nname: described\nfiles:\n  - CLAUDE.md\ninstall:\n  command: pnpm install --frozen-lockfile\nprepare:\n  command: pnpm build\ncleanup:\n  command: git clean -xdf\n',
    });
    const harness = await resolveHarness(
      { source: dir, trusted: false },
      {
        home,
        agentId: 'claude-code',
        logger: createRecordingLogger(),
        git: async () => ({ stdout: '', exitCode: 128 }),
      },
    );
    expect(describeExecution(harness)).toEqual({
      commands: ['pnpm install --frozen-lockfile', 'pnpm build', 'git clean -xdf'],
      files: ['CLAUDE.md'],
    });
  });
});
