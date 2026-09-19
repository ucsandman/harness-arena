import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/claude-code/adapter';
import { CodexAdapter } from '../src/codex/adapter';
import { OpenCodeAdapter } from '../src/opencode/adapter';
import {
  countByType,
  emptyPathEnv,
  makeExecuteContext,
  makePrepareContext,
  makeTempDir,
  readFixture,
  removeTempDir,
  scriptedRunner,
  TEST_LIMITS,
} from './helpers';

/** The shared CLI execute() path: lines in, events and an AdapterResult out. No process is spawned. */
describe('runCliProcess through ClaudeCodeAdapter.execute', () => {
  it('streams the real capture through the parser and reports completed', async () => {
    const adapter = new ClaudeCodeAdapter();
    const prepared = await adapter.prepare(
      makePrepareContext({ agent: { id: 'claude-code', model: 'claude-haiku-4-5' } }),
    );
    const lines = (await readFixture('claude-code/success.ndjson')).split(/\r?\n/).filter((l) => l.trim());
    const harness = makeExecuteContext(scriptedRunner({ stdout: lines, exitCode: 0 }));

    const result = await adapter.execute(prepared, harness.ctx);

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.turns).toBe(2);
    expect(result.usage?.costUsd).toBe(0.0294388);
    expect(result.errorCode).toBeNull();
    expect(countByType(harness.events)['agent.started']).toBe(1);
    expect(harness.events).toHaveLength(12);
  });

  it('reports not_installed when the binary could not be spawned', async () => {
    const adapter = new ClaudeCodeAdapter();
    const prepared = await adapter.prepare(makePrepareContext());
    const harness = makeExecuteContext(
      scriptedRunner({ exitCode: null, spawnError: 'ENOENT: claude could not be found on PATH' }),
    );

    const result = await adapter.execute(prepared, harness.ctx);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('not_installed');
    expect(result.errorMessage).toContain('ENOENT');
  });

  it('reports timed_out and emits a timeout limit', async () => {
    const adapter = new ClaudeCodeAdapter();
    const prepared = await adapter.prepare(makePrepareContext());
    const harness = makeExecuteContext(scriptedRunner({ exitCode: null, timedOut: true }), {
      ...TEST_LIMITS,
      timeoutMs: 1000,
    });

    const result = await adapter.execute(prepared, harness.ctx);

    expect(result.status).toBe('timed_out');
    expect(result.errorCode).toBe('timeout');
    expect(harness.events.filter((e) => e.type === 'limit.hit')).toHaveLength(1);
  });

  it('reports interrupted and emits an interrupt event', async () => {
    const adapter = new ClaudeCodeAdapter();
    const prepared = await adapter.prepare(makePrepareContext());
    const harness = makeExecuteContext(scriptedRunner({ exitCode: null, aborted: true }));

    const result = await adapter.execute(prepared, harness.ctx);

    expect(result.status).toBe('interrupted');
    expect(result.errorCode).toBe('interrupted');
    expect(harness.events.map((e) => e.type)).toContain('interrupt');
  });

  it('classifies a failure from stderr when the stream said nothing', async () => {
    const adapter = new ClaudeCodeAdapter();
    const prepared = await adapter.prepare(makePrepareContext());
    const harness = makeExecuteContext(
      scriptedRunner({ stderr: ['Error: not logged in. Run /login first.'], exitCode: 1 }),
    );

    const result = await adapter.execute(prepared, harness.ctx);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('auth');
  });

  it('keeps raw lines available to the caller', async () => {
    const adapter = new ClaudeCodeAdapter();
    const prepared = await adapter.prepare(makePrepareContext());
    const raw: string[] = [];
    const harness = makeExecuteContext(scriptedRunner({ stdout: ['{"type":"system","subtype":"init"}'] }));

    await adapter.execute(prepared, { ...harness.ctx, onRawLine: (_stream, line) => raw.push(line) });

    expect(raw).toEqual(['{"type":"system","subtype":"init"}']);
  });
});

/**
 * OpenCode passes the prompt in argv, and on Windows it is a `.cmd` shim: cmd.exe cannot carry a line
 * break in an argument, so such a run must fail with a reason instead of crashing the spawn. The
 * platform is injected so this holds on Linux CI too.
 */
describe('OpenCodeAdapter with a multi-line prompt on a Windows shim', () => {
  let shimDir: string;

  beforeEach(async () => {
    shimDir = await makeTempDir('arena-opencode-shim-');
    await writeFile(path.join(shimDir, 'opencode.cmd'), '@echo off\r\n', 'utf8');
  });

  afterEach(async () => {
    await removeTempDir(shimDir);
  });

  const contextFor = (prompt: string) =>
    makePrepareContext({
      agent: { id: 'opencode' },
      env: emptyPathEnv({ PATH: shimDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
      task: { title: 'multi line', prompt, source: { kind: 'prompt' } },
    });

  const NEVER_SPAWN = {
    run: async () => {
      throw new Error('a refused prompt must never reach the process runner');
    },
  };

  it('fails with unsupported_prompt without spawning anything', async () => {
    const adapter = new OpenCodeAdapter({ platform: 'win32' });
    const prepared = await adapter.prepare(contextFor('line one\nline two'));
    const harness = makeExecuteContext(NEVER_SPAWN);

    expect(prepared.command.toLowerCase()).toBe(path.join(shimDir, 'opencode.cmd').toLowerCase());
    expect(prepared.disclosure.notes.join(' ')).toMatch(/line break/i);

    const result = await adapter.execute(prepared, harness.ctx);

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe('unsupported_prompt');
    expect(result.errorMessage).toMatch(/line break/i);
    expect(harness.events.map((e) => e.type)).toEqual(['error']);
  });

  it('runs the same shim normally when the prompt is a single line', async () => {
    const adapter = new OpenCodeAdapter({ platform: 'win32' });
    const prepared = await adapter.prepare(contextFor('one line prompt'));
    const harness = makeExecuteContext(scriptedRunner({ exitCode: 0 }));

    expect(prepared.disclosure.notes.join(' ')).not.toMatch(/line break/i);

    const result = await adapter.execute(prepared, harness.ctx);

    expect(result.status).toBe('completed');
    expect(result.errorCode).toBeNull();
  });

  it('accepts a multi-line prompt off Windows, where no shim is involved', async () => {
    const adapter = new OpenCodeAdapter({ platform: 'linux' });
    const prepared = await adapter.prepare(contextFor('line one\nline two'));
    const harness = makeExecuteContext(scriptedRunner({ exitCode: 0 }));

    const result = await adapter.execute(prepared, harness.ctx);

    expect(result.status).toBe('completed');
    expect(result.errorCode).toBeNull();
  });

  it('declares the limitation in capabilities notes', () => {
    expect(new OpenCodeAdapter().capabilities().notes.join(' ')).toMatch(/line break/i);
  });
});

describe('runCliProcess through CodexAdapter.execute', () => {
  it('reports the provider limit and falls back to the requested model', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      makePrepareContext({ agent: { id: 'codex', model: 'gpt-5.1-codex' } }),
    );
    const lines = (await readFixture('codex/usage-limit.ndjson')).split(/\r?\n/).filter((l) => l.trim());
    const harness = makeExecuteContext(scriptedRunner({ stdout: lines, exitCode: 1 }));

    const result = await adapter.execute(prepared, harness.ctx);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('provider_limit');
    // Codex never names the model in its stream, so the adapter reports what it asked for.
    expect(result.model).toBe('gpt-5.1-codex');
    expect(countByType(harness.events)['limit.hit']).toBe(1);
  });
});
