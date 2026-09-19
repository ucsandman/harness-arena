import { describe, expect, it } from 'vitest';
import { GeminiCliParser } from '../src/gemini-cli/parser';
import { eventsOfType, feedLines, readFixture } from './helpers';

describe('GeminiCliParser against the real auth-error capture', () => {
  it('classifies the ineligible-tier failure as auth', async () => {
    const text = await readFixture('gemini-cli/auth-error.txt');
    const { counts, events, result } = feedLines(new GeminiCliParser(), text, 'stderr');

    expect(counts).toEqual({ error: 1 });
    const error = eventsOfType(events, 'error')[0];
    expect(error?.payload.fatal).toBe(true);
    expect(error?.payload.code).toBe('auth');
    expect(error?.payload.message).toContain('IneligibleTierError');

    expect(result.errorCode).toBe('auth');
    expect(result.status).toBe('failed');
    expect(result.usage).toBeNull();
  });
});

describe('GeminiCliParser against the synthetic success fixture', () => {
  it('translates stream-json lines into the expected event counts', async () => {
    const text = await readFixture('gemini-cli/synthetic-success.ndjson');
    const { counts, events } = feedLines(new GeminiCliParser(), text);

    expect(counts).toEqual({
      'agent.started': 1,
      'agent.output': 2,
      'tool.called': 3,
      'tool.result': 3,
      'model.response': 1,
    });
    expect(events).toHaveLength(10);
  });

  it('records the session, model, tool ids and stats', async () => {
    const text = await readFixture('gemini-cli/synthetic-success.ndjson');
    const { events, result } = feedLines(new GeminiCliParser(), text);

    expect(eventsOfType(events, 'agent.started')[0]?.payload).toMatchObject({
      sessionId: '3f9c1d54-7a2b-4f61-9c0e-8d5a2b7e4411',
      model: 'gemini-3-pro-preview',
    });
    expect(eventsOfType(events, 'tool.called').map((e) => e.payload.name)).toEqual([
      'read_file',
      'replace',
      'run_shell_command',
    ]);
    expect(eventsOfType(events, 'tool.result').every((e) => e.payload.ok)).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 21000,
      outputTokens: 3680,
      cacheReadTokens: 15000,
      totalTokens: 24680,
    });
    expect(result.model).toBe('gemini-3-pro-preview');
    expect(result.finalResponse).toContain('milliseconds');
    expect(result.errorCode).toBeNull();
  });

  it('marks a failed tool result as not ok', () => {
    const parser = new GeminiCliParser();
    const events = parser.feed(
      JSON.stringify({ type: 'tool_result', tool_id: 't1', status: 'error', output: 'file not found' }),
    );
    expect(events[0]?.payload).toMatchObject({ toolId: 't1', ok: false });
  });

  it('reports a provider limit from a JSON error line', () => {
    const parser = new GeminiCliParser();
    const events = parser.feed(
      JSON.stringify({ type: 'error', message: 'Resource exhausted: quota exceeded for this project' }),
    );
    const { result } = parser.finish();

    expect(events.map((e) => e.type)).toEqual(['limit.hit', 'error']);
    expect(result.errorCode).toBe('provider_limit');
  });
});
