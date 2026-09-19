import { describe, expect, it } from 'vitest';
import { OpenCodeParser } from '../src/opencode/parser';
import { eventsOfType, feedLines, readFixture } from './helpers';

describe('OpenCodeParser against the real provider-error capture', () => {
  it('emits one fatal error and no limit event for a 500', async () => {
    const text = await readFixture('opencode/provider-error.ndjson');
    const { counts, events, result } = feedLines(new OpenCodeParser(), text);

    expect(counts).toEqual({ error: 1 });
    expect(eventsOfType(events, 'error')[0]?.payload).toMatchObject({
      code: 'unknown',
      message: 'Internal server error',
      fatal: true,
    });
    expect(result.errorCode).toBe('unknown');
    expect(result.status).toBe('failed');
    expect(result.native).toMatchObject({ sessionId: 'ses_f465d48b5ffeGqFwvs472QLAdO' });
  });
});

describe('OpenCodeParser against the synthetic success fixture', () => {
  it('translates run --format json lines into the expected event counts', async () => {
    const text = await readFixture('opencode/synthetic-success.ndjson');
    const { counts, events } = feedLines(new OpenCodeParser(), text);

    expect(counts).toEqual({
      'model.request': 1,
      'tool.called': 3,
      'tool.result': 3,
      'agent.output': 1,
      'model.response': 1,
    });
    expect(events).toHaveLength(9);
  });

  it('reads tokens and cost from step_finish', async () => {
    const text = await readFixture('opencode/synthetic-success.ndjson');
    const { events, result } = feedLines(new OpenCodeParser(), text);

    expect(eventsOfType(events, 'tool.called').map((e) => e.payload.name)).toEqual(['read', 'edit', 'bash']);
    expect(eventsOfType(events, 'tool.called')[0]?.payload.toolId).toBe('call_1');
    expect(result.usage).toEqual({
      inputTokens: 18400,
      outputTokens: 2100,
      cacheReadTokens: 12000,
      cacheWriteTokens: 1800,
      costUsd: 0.0413,
    });
    expect(result.turns).toBe(1);
    expect(result.finalResponse).toContain('2 passing');
  });

  it('does not repeat tool.called when a tool is reported running then completed', () => {
    const parser = new OpenCodeParser();
    const running = parser.feed(
      JSON.stringify({
        type: 'tool_use',
        part: { callID: 'call_9', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } },
      }),
    );
    const done = parser.feed(
      JSON.stringify({
        type: 'tool_use',
        part: {
          callID: 'call_9',
          tool: 'bash',
          state: { status: 'error', input: { command: 'ls' }, output: 'boom' },
        },
      }),
    );

    expect(running.map((e) => e.type)).toEqual(['tool.called']);
    expect(done.map((e) => e.type)).toEqual(['tool.result']);
    expect(done[0]?.payload).toMatchObject({ toolId: 'call_9', ok: false, output: 'boom' });
  });

  it('flags a provider rate limit', () => {
    const parser = new OpenCodeParser();
    const events = parser.feed(
      JSON.stringify({
        type: 'error',
        error: { type: 'provider.rate_limit', message: 'Rate limit exceeded' },
      }),
    );
    const { result } = parser.finish();

    expect(events.map((e) => e.type)).toEqual(['limit.hit', 'error']);
    expect(result.errorCode).toBe('provider_limit');
  });
});
