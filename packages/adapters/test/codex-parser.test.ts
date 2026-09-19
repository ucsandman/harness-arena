import { describe, expect, it } from 'vitest';
import { CodexParser } from '../src/codex/parser';
import { eventsOfType, feedLines, readFixture } from './helpers';

describe('CodexParser against the real usage-limit capture', () => {
  it('reports a provider limit once and one fatal error', async () => {
    const text = await readFixture('codex/usage-limit.ndjson');
    const { counts, events, result } = feedLines(new CodexParser(), text);

    expect(counts).toEqual({
      'agent.started': 1,
      'model.request': 1,
      error: 2,
      'limit.hit': 1,
    });
    const limit = eventsOfType(events, 'limit.hit')[0];
    expect(limit?.payload.kind).toBe('provider_limit');
    expect(limit?.payload.detail).toContain('usage limit');

    const fatal = eventsOfType(events, 'error').filter((e) => e.payload.fatal);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]?.payload.code).toBe('provider_limit');

    expect(result.errorCode).toBe('provider_limit');
    expect(result.errorMessage).toContain("You've hit your usage limit");
    expect(result.status).toBe('failed');
    expect(result.native).toMatchObject({ threadId: '01a0b9a8-7e94-7441-9b09-3bb4ff92482d' });
  });

  it('keeps the non-fatal item error separate from the fatal one', async () => {
    const text = await readFixture('codex/usage-limit.ndjson');
    const { events } = feedLines(new CodexParser(), text);
    const nonFatal = eventsOfType(events, 'error').filter((e) => !e.payload.fatal);

    expect(nonFatal).toHaveLength(1);
    expect(nonFatal[0]?.payload.message).toContain('Skill descriptions were shortened');
  });
});

describe('CodexParser against the synthetic success fixture', () => {
  it('translates items into the expected event counts', async () => {
    const text = await readFixture('codex/synthetic-success.ndjson');
    const { counts, events } = feedLines(new CodexParser(), text);

    expect(counts).toEqual({
      'agent.started': 1,
      'model.request': 1,
      'agent.thinking': 1,
      'tool.called': 4,
      'command.started': 2,
      'command.completed': 2,
      'tool.result': 3,
      'file.changed': 1,
      'agent.output': 1,
      'model.response': 1,
    });
    expect(events).toHaveLength(17);
  });

  it('maps command_execution exit codes and file_change kinds', async () => {
    const text = await readFixture('codex/synthetic-success.ndjson');
    const { events } = feedLines(new CodexParser(), text);
    const completions = eventsOfType(events, 'command.completed');
    const changed = eventsOfType(events, 'file.changed')[0];

    expect(completions.map((e) => e.payload.exitCode)).toEqual([1, 0]);
    expect(eventsOfType(events, 'tool.result').map((e) => e.payload.ok)).toEqual([false, true, true]);
    expect(changed?.payload).toMatchObject({ path: 'src/auth/session.js', kind: 'modify' });
  });

  it('sums turn usage and records the final agent message', async () => {
    const text = await readFixture('codex/synthetic-success.ndjson');
    const { result } = feedLines(new CodexParser(), text);

    expect(result.usage).toEqual({ inputTokens: 12000, cacheReadTokens: 8000, outputTokens: 1500 });
    expect(result.turns).toBe(1);
    expect(result.finalResponse).toContain('node --test passes');
    expect(result.model).toBeNull();
    expect(result.errorCode).toBeNull();
  });

  it('maps add and delete file changes to create and delete', () => {
    const parser = new CodexParser();
    const events = parser.feed(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_x',
          type: 'file_change',
          status: 'completed',
          changes: [
            { path: 'a.js', kind: 'add' },
            { path: 'b.js', kind: 'delete' },
            { path: 'c.js', kind: 'update' },
          ],
        },
      }),
    );

    expect(events.map((e) => (e.type === 'file.changed' ? e.payload.kind : null))).toEqual([
      'create',
      'delete',
      'modify',
    ]);
  });
});
