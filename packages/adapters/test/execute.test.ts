import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/claude-code/adapter';
import { CodexAdapter } from '../src/codex/adapter';
import {
  countByType,
  makeExecuteContext,
  makePrepareContext,
  readFixture,
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
