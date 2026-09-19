import { describe, expect, it } from 'vitest';
import { ClaudeCodeParser } from '../src/claude-code/parser';
import { eventsOfType, feedLines, readFixture } from './helpers';

/**
 * Asserted against the real capture in fixtures/claude-code/success.ndjson
 * (Claude Code 2.1.278, --output-format stream-json --verbose).
 */
describe('ClaudeCodeParser against the real 2.1.278 capture', () => {
  it('translates every line into the expected event counts', async () => {
    const text = await readFixture('claude-code/success.ndjson');
    const { counts, events } = feedLines(new ClaudeCodeParser(), text);

    expect(counts).toEqual({
      'agent.started': 1,
      'agent.thinking': 2,
      'model.response': 3,
      'tool.called': 1,
      'file.changed': 1,
      warning: 1,
      'tool.result': 1,
      'agent.output': 2,
    });
    expect(events).toHaveLength(12);
  });

  it('reports the session, model, tools and version from system/init', async () => {
    const text = await readFixture('claude-code/success.ndjson');
    const { events } = feedLines(new ClaudeCodeParser(), text);
    const started = eventsOfType(events, 'agent.started')[0];

    expect(started?.payload.sessionId).toBe('f666581e-afec-4005-bc57-e4c0bc8ed6ae');
    expect(started?.payload.model).toBe('claude-haiku-4-5-20251001');
    expect(started?.payload.version).toBe('2.1.278');
    expect(started?.payload.tools).toContain('Bash');
    expect(started?.payload.cwdKnown).toBe(true);
  });

  it('maps the Write tool call to tool.called plus file.changed create', async () => {
    const text = await readFixture('claude-code/success.ndjson');
    const { events } = feedLines(new ClaudeCodeParser(), text);
    const call = eventsOfType(events, 'tool.called')[0];
    const changed = eventsOfType(events, 'file.changed')[0];
    const result = eventsOfType(events, 'tool.result')[0];

    expect(call?.payload.name).toBe('Write');
    expect(call?.payload.toolId).toBe('toolu_01JnfhcAiy6eSfLyhVBA5qpy');
    expect(call?.payload.parentToolId).toBeNull();
    expect(changed?.payload.kind).toBe('create');
    expect(changed?.payload.path).toContain('hello-claude.txt');
    expect(result?.payload.toolId).toBe('toolu_01JnfhcAiy6eSfLyhVBA5qpy');
    expect(result?.payload.ok).toBe(true);
    expect(result?.payload.name).toBe('Write');
  });

  it('turns rate_limit_event into a warning and the result text into a final output', async () => {
    const text = await readFixture('claude-code/success.ndjson');
    const { events } = feedLines(new ClaudeCodeParser(), text);
    const warning = eventsOfType(events, 'warning')[0];
    const finals = eventsOfType(events, 'agent.output').filter((e) => e.payload.final === true);

    expect(warning?.payload.code).toBe('rate_limit');
    expect(warning?.payload.message).toContain('five_hour');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload.text).toBe('DONE');
  });

  it('fills usage, model, turns, finalResponse and native from the result line', async () => {
    const text = await readFixture('claude-code/success.ndjson');
    const { result } = feedLines(new ClaudeCodeParser(), text);

    expect(result.usage).toEqual({
      inputTokens: 17,
      outputTokens: 379,
      cacheReadTokens: 45628,
      cacheWriteTokens: 11482,
      costUsd: 0.0294388,
    });
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.version).toBe('2.1.278');
    expect(result.turns).toBe(2);
    expect(result.finalResponse).toBe('DONE');
    expect(result.errorCode).toBeNull();
    expect(result.native).toMatchObject({
      sessionId: 'f666581e-afec-4005-bc57-e4c0bc8ed6ae',
      subtype: 'success',
    });
    expect((result.native?.subagent_stats as { spawned: number }).spawned).toBe(0);
  });

  it('counts one model.response per assistant message, not per stream line', async () => {
    const text = await readFixture('claude-code/success.ndjson');
    const { events } = feedLines(new ClaudeCodeParser(), text);
    const perMessage = eventsOfType(events, 'model.response').filter((e) => e.native === 'assistant/usage');

    // The capture repeats identical usage for two lines of the same message id.
    expect(perMessage).toHaveLength(2);
  });
});

describe('ClaudeCodeParser on synthetic edge cases', () => {
  const line = (value: unknown): string => JSON.stringify(value);

  it('emits command.started and command.completed for Bash tool calls', () => {
    const parser = new ClaudeCodeParser();
    const events = [
      ...parser.feed(
        line({
          type: 'assistant',
          message: {
            id: 'msg_1',
            model: 'claude-x',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'node --test' } }],
          },
        }),
      ),
      ...parser.feed(
        line({
          type: 'user',
          message: {
            role: 'user',
            content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok', is_error: false }],
          },
        }),
      ),
    ];

    const started = events.find((e) => e.type === 'command.started');
    const completed = events.find((e) => e.type === 'command.completed');
    expect(started?.payload).toMatchObject({ commandId: 'toolu_1', command: 'node --test' });
    expect(completed?.payload).toMatchObject({ commandId: 'toolu_1', exitCode: null });
  });

  it('maps Task tool calls to subagent.spawned and subagent.completed', () => {
    const parser = new ClaudeCodeParser();
    const events = [
      ...parser.feed(
        line({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_9',
                name: 'Task',
                input: { subagent_type: 'test-repair', description: 'find the unit mismatch' },
              },
            ],
          },
        }),
      ),
      ...parser.feed(
        line({
          type: 'user',
          message: {
            role: 'user',
            content: [{ tool_use_id: 'toolu_9', type: 'tool_result', content: 'done' }],
          },
        }),
      ),
    ];

    expect(events.find((e) => e.type === 'subagent.spawned')?.payload).toMatchObject({
      subagentId: 'toolu_9',
      name: 'test-repair',
    });
    expect(events.find((e) => e.type === 'subagent.completed')?.payload).toMatchObject({
      subagentId: 'toolu_9',
      status: 'completed',
    });
  });

  it('maps Read, Glob and Grep to file.read when a path is present', () => {
    const parser = new ClaudeCodeParser();
    const events = parser.feed(
      line({
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/src/a.js' } },
            { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x', path: '/repo/src' } },
            { type: 'tool_use', id: 't3', name: 'Glob', input: { pattern: '**/*.js' } },
          ],
        },
      }),
    );

    const reads = events.filter((e) => e.type === 'file.read');
    expect(reads).toHaveLength(2);
    expect(reads.map((e) => (e.type === 'file.read' ? e.payload.path : ''))).toEqual([
      '/repo/src/a.js',
      '/repo/src',
    ]);
  });

  it('reports max turns as a limit and an error', () => {
    const parser = new ClaudeCodeParser();
    const events = parser.feed(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 40,
        result: null,
        usage: { input_tokens: 10, output_tokens: 20 },
        total_cost_usd: 0.5,
        permission_denials: [{ tool_name: 'Bash' }],
      }),
    );
    const { result } = parser.finish();

    expect(events.filter((e) => e.type === 'limit.hit')).toHaveLength(1);
    expect(events.find((e) => e.type === 'limit.hit')?.payload).toMatchObject({ kind: 'max_turns' });
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'human.intervention')).toHaveLength(1);
    expect(events.find((e) => e.type === 'human.intervention')?.payload).toMatchObject({
      kind: 'permission',
      automated: true,
    });
    expect(result.errorCode).toBe('max_turns');
    expect(result.status).toBe('failed');
  });

  it('maps a compact boundary to context.compacted', () => {
    const parser = new ClaudeCodeParser();
    const events = parser.feed(
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('context.compacted');
    expect(events[0]?.payload).toMatchObject({ trigger: 'auto' });
  });

  it('ignores prose on stdout and keeps stderr for classification', () => {
    const parser = new ClaudeCodeParser();
    expect(parser.feed('not json at all')).toEqual([]);
    expect(parser.feed('Error: not logged in. Run /login.', 'stderr')).toEqual([]);
    const { result } = parser.finish();
    expect(result.errorCode).toBe('auth');
    expect(result.errorMessage).toContain('not logged in');
  });
});
