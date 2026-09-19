import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/claude-code/adapter';
import { CodexAdapter } from '../src/codex/adapter';
import { GeminiCliAdapter } from '../src/gemini-cli/adapter';
import { OpenCodeAdapter } from '../src/opencode/adapter';
import { FAKE_FIXTURE_ENV, FakeAdapter } from '../src/fake/adapter';
import { emptyPathEnv, makePrepareContext, makeTempDir, removeTempDir, TEST_LIMITS } from './helpers';

const PROMPT = 'Fix the failing test in src/auth/session.js';

describe('ClaudeCodeAdapter.prepare', () => {
  it('builds the exact argv and keeps the prompt on stdin', async () => {
    const adapter = new ClaudeCodeAdapter();
    const prepared = await adapter.prepare(
      makePrepareContext({
        workspace: '/tmp/arena/ws-a',
        agent: { id: 'claude-code', model: 'claude-sonnet-4-6', args: ['--from-agent'] },
        agentConfig: { args: ['--from-config'] },
        limits: { ...TEST_LIMITS, maxTurns: 40, maxBudgetUsd: 3.5 },
      }),
    );

    expect(prepared.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--setting-sources',
      'project,local',
      '--strict-mcp-config',
      '--model',
      'claude-sonnet-4-6',
      '--max-turns',
      '40',
      '--max-budget-usd',
      '3.5',
      '--from-config',
      '--from-agent',
    ]);
    expect(prepared.command).toBe('claude');
    expect(prepared.stdin).toBe(PROMPT);
    expect(prepared.args).not.toContain(PROMPT);
    expect(prepared.disclosure.promptVia).toBe('stdin');
    expect(prepared.userConfigIsolated).toBe(true);
    expect(prepared.cwd).toBe('/tmp/arena/ws-a');
  });

  it('resolves settings, mcp config and a systemPromptAppend file inside the harness', async () => {
    const harnessDir = await makeTempDir('arena-harness-');
    try {
      await mkdir(path.join(harnessDir, '.claude'), { recursive: true });
      await writeFile(path.join(harnessDir, '.claude', 'settings.json'), '{}', 'utf8');
      await writeFile(path.join(harnessDir, '.mcp.json'), '{}', 'utf8');
      await writeFile(path.join(harnessDir, 'prompt.md'), 'Always run the tests.\n', 'utf8');

      const prepared = await new ClaudeCodeAdapter().prepare(
        makePrepareContext({
          harnessDir,
          agentConfig: {
            settings: '.claude/settings.json',
            mcpConfig: '.mcp.json',
            systemPromptAppend: 'prompt.md',
          },
        }),
      );

      const settingsIndex = prepared.args.indexOf('--settings');
      const mcpIndex = prepared.args.indexOf('--mcp-config');
      const appendIndex = prepared.args.indexOf('--append-system-prompt');

      expect(prepared.args[settingsIndex + 1]).toBe(path.join(harnessDir, '.claude', 'settings.json'));
      expect(prepared.args[mcpIndex + 1]).toBe(path.join(harnessDir, '.mcp.json'));
      expect(prepared.args[appendIndex + 1]).toBe('Always run the tests.\n');
      expect(prepared.disclosure.notes.join(' ')).toContain('loaded from the harness file');
    } finally {
      await removeTempDir(harnessDir);
    }
  });

  it('refuses a settings path that escapes the harness directory', async () => {
    const prepared = await new ClaudeCodeAdapter().prepare(
      makePrepareContext({ agentConfig: { settings: '../../etc/passwd' } }),
    );

    expect(prepared.args).not.toContain('--settings');
    expect(prepared.disclosure.notes.join(' ')).toContain('outside the harness directory');
  });

  it('passes literal text through systemPromptAppend when it is not a file path', async () => {
    const prepared = await new ClaudeCodeAdapter().prepare(
      makePrepareContext({ agentConfig: { systemPromptAppend: 'Be terse.' } }),
    );
    const index = prepared.args.indexOf('--append-system-prompt');
    expect(prepared.args[index + 1]).toBe('Be terse.');
  });
});

describe('CodexAdapter.prepare', () => {
  it('builds the exact argv with the workspace and a trailing stdin marker', async () => {
    const prepared = await new CodexAdapter().prepare(
      makePrepareContext({
        workspace: '/tmp/arena/ws-b',
        agent: { id: 'codex', model: 'gpt-5.1-codex', args: ['--extra'] },
      }),
    );

    expect(prepared.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      '/tmp/arena/ws-b',
      '-m',
      'gpt-5.1-codex',
      '--extra',
      '-',
    ]);
    expect(prepared.args).not.toContain(PROMPT);
    expect(prepared.stdin).toBe(PROMPT);
    expect(prepared.userConfigIsolated).toBe(true);
    expect(prepared.args).not.toContain('-o');
  });
});

describe('GeminiCliAdapter.prepare', () => {
  it('builds the exact argv, passes no -p flag and reports no isolation', async () => {
    const prepared = await new GeminiCliAdapter().prepare(
      makePrepareContext({ agent: { id: 'gemini-cli', model: 'gemini-3-pro-preview' } }),
    );

    expect(prepared.args).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--skip-trust',
      '-m',
      'gemini-3-pro-preview',
    ]);
    expect(prepared.args).not.toContain('-p');
    expect(prepared.stdin).toBe(PROMPT);
    expect(prepared.userConfigIsolated).toBe(false);
    expect(prepared.disclosure.notes.join(' ')).toContain('~/.gemini');
  });
});

describe('OpenCodeAdapter.prepare', () => {
  it('passes the prompt as the final argument and keeps it out of the disclosure', async () => {
    const prepared = await new OpenCodeAdapter().prepare(
      makePrepareContext({ agent: { id: 'opencode', model: 'anthropic/claude-sonnet-4-6' } }),
    );

    expect(prepared.args).toEqual([
      'run',
      '--standalone',
      '--format',
      'json',
      '--auto',
      '--model',
      'anthropic/claude-sonnet-4-6',
      PROMPT,
    ]);
    expect(prepared.stdin).toBeNull();
    expect(prepared.disclosure.promptVia).toBe('arg');
    expect(prepared.disclosure.args).not.toContain(PROMPT);
    expect(prepared.userConfigIsolated).toBe(false);
  });
});

describe('child environment', () => {
  it('sets the ARENA variables, drops CLAUDECODE and substitutes placeholders', async () => {
    const prepared = await new ClaudeCodeAdapter().prepare(
      makePrepareContext({
        runId: 'run_abcdefgh12345678',
        side: 'b',
        workspace: '/tmp/arena/ws-b',
        harnessDir: '/tmp/arena/harness',
        env: emptyPathEnv({ SECRET_TOKEN: 'keep-me' }),
        agentConfig: { env: { HARNESS_ROOT: '${ARENA_HARNESS_DIR}/files' } },
        agent: { id: 'claude-code', env: { WORKSPACE_COPY: '${ARENA_WORKSPACE}' } },
      }),
    );

    expect(prepared.env.ARENA_RUN_ID).toBe('run_abcdefgh12345678');
    expect(prepared.env.ARENA_SIDE).toBe('b');
    expect(prepared.env.ARENA_WORKSPACE).toBe('/tmp/arena/ws-b');
    expect(prepared.env.ARENA_BATTLE).toBe('1');
    expect(prepared.env.CLAUDECODE).toBeUndefined();
    expect(prepared.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(prepared.env.HARNESS_ROOT).toBe('/tmp/arena/harness/files');
    expect(prepared.env.WORKSPACE_COPY).toBe('/tmp/arena/ws-b');
    expect(prepared.env.SECRET_TOKEN).toBe('keep-me');

    expect(prepared.disclosure.envKeysAdded).toEqual([
      'ARENA_BATTLE',
      'ARENA_RUN_ID',
      'ARENA_SIDE',
      'ARENA_WORKSPACE',
      'HARNESS_ROOT',
      'WORKSPACE_COPY',
    ]);
    // Disclosure lists key names only: no value ever appears in it.
    expect(JSON.stringify(prepared.disclosure)).not.toContain('keep-me');
  });

  it('puts the fake fixture reference in the child environment', async () => {
    const prepared = await new FakeAdapter().prepare(makePrepareContext({ fixture: 'quick-success' }));

    expect(prepared.env[FAKE_FIXTURE_ENV]).toBe('quick-success');
    expect(prepared.args).toEqual(['--fixture', 'quick-success']);
    expect(prepared.disclosure.envKeysAdded).toContain(FAKE_FIXTURE_ENV);
  });
});
