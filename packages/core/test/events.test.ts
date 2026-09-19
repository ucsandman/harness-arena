import { describe, expect, it } from 'vitest';
import { EVENT_LIMITS, privacySettingsSchema } from '@harness-arena/protocol';
import type { AdapterEvent, ArenaEvent, PrivacyExclusion } from '@harness-arena/protocol';
import { createEventBus } from '../src/events.js';
import { createRedactor } from '../src/redact.js';

const BATTLE_ID = 'btl_0000000000000abc';
const RUN_ID = 'run_0000000000000abc';
const STARTED_AT = 10_000;

function makeBus(exclude: PrivacyExclusion[] = [], now = 15_000) {
  const written: ArenaEvent[] = [];
  const bus = createEventBus({
    battleId: BATTLE_ID,
    startedAt: STARTED_AT,
    redactor: createRedactor({ envValues: ['topsecretvalue'] }),
    privacy: privacySettingsSchema.parse({ exclude }),
    sink: (event) => written.push(event),
    now: () => now,
  });
  return { bus, written };
}

const output = (text: string): AdapterEvent => ({
  type: 'agent.output',
  payload: { role: 'assistant', text },
});

describe('createEventBus envelope', () => {
  it('assigns monotonic seq, ids, offsets and source', () => {
    const { bus, written } = makeBus();
    bus.emit('a', RUN_ID, 'fake', { type: 'agent.thinking', payload: { chars: 1 }, native: 'thought' });
    bus.emit('b', RUN_ID, 'fake', { type: 'agent.thinking', payload: { chars: 2 } });
    expect(written.map((e) => e.seq)).toEqual([1, 2]);
    expect(written[0]?.id.startsWith('evt_')).toBe(true);
    expect(written[0]?.battleId).toBe(BATTLE_ID);
    expect(written[0]?.side).toBe('a');
    expect(written[0]?.source).toEqual({ adapter: 'fake', native: 'thought' });
    expect(written[1]?.source).toEqual({ adapter: 'fake' });
    expect(written[0]?.confidence).toBe('observed');
    expect(bus.seq()).toBe(2);
    expect(bus.count()).toBe(2);
  });

  it('computes tOffsetMs from the battle start and never goes negative', () => {
    const { bus, written } = makeBus();
    bus.emit('a', RUN_ID, 'fake', { type: 'agent.thinking', payload: { chars: 1 }, at: STARTED_AT + 2500 });
    bus.emit('a', RUN_ID, 'fake', { type: 'agent.thinking', payload: { chars: 2 }, at: STARTED_AT - 5000 });
    expect(written[0]?.tOffsetMs).toBe(2500);
    expect(written[0]?.ts).toBe(new Date(STARTED_AT + 2500).toISOString());
    expect(written[1]?.tOffsetMs).toBe(0);
  });

  it('uses the clock when the adapter gives no timestamp', () => {
    const { bus, written } = makeBus([], 19_000);
    bus.emit(null, null, 'arena', { type: 'agent.thinking', payload: { chars: 1 } });
    expect(written[0]?.tOffsetMs).toBe(9000);
    expect(written[0]?.runId).toBeNull();
    expect(written[0]?.side).toBeNull();
  });

  it('applies schema defaults from the protocol', () => {
    const { bus, written } = makeBus();
    bus.emit(null, null, 'arena', {
      type: 'battle.started',
      payload: {
        title: 'x',
        a: { label: 'A', agent: 'fake', harness: 'vanilla' },
        b: { label: 'B', agent: 'fake', harness: 'vanilla' },
        mode: 'local',
      },
    } as unknown as AdapterEvent);
    expect((written[0]?.payload as { demo: boolean }).demo).toBe(false);
  });

  it('turns an invalid event into a warning instead of throwing', () => {
    const { bus, written } = makeBus();
    const result = bus.emit('a', RUN_ID, 'fake', {
      type: 'test.completed',
      payload: { command: 'node --test' },
    } as unknown as AdapterEvent);
    expect(result?.type).toBe('warning');
    expect((result?.payload as { code: string }).code).toBe('event_invalid');
    expect((result?.payload as { message: string }).message).toContain('test.completed');
    expect(written).toHaveLength(1);
    expect(bus.seq()).toBe(1);
  });

  it('redacts secrets in the payload', () => {
    const { bus, written } = makeBus();
    bus.emit('a', RUN_ID, 'fake', output('the key is topsecretvalue'));
    expect((written[0]?.payload as { text: string }).text).not.toContain('topsecretvalue');
  });
});

describe('privacy exclusions', () => {
  it('prompts: drops user output and tool inputs', () => {
    const { bus, written } = makeBus(['prompts']);
    const dropped = bus.emit('a', RUN_ID, 'fake', {
      type: 'agent.output',
      payload: { role: 'user', text: 'my prompt' },
    });
    expect(dropped).toBeNull();
    bus.emit('a', RUN_ID, 'fake', {
      type: 'tool.called',
      payload: { toolId: 't1', name: 'Bash', input: { command: 'ls' } },
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.payload).not.toHaveProperty('input');
    expect((written[0]?.payload as { name: string }).name).toBe('Bash');
  });

  it('model_outputs: replaces assistant text and marks it truncated', () => {
    const { bus, written } = makeBus(['model_outputs']);
    bus.emit('a', RUN_ID, 'fake', output('a long answer'));
    expect(written[0]?.payload).toEqual({ role: 'assistant', text: '[excluded]', truncated: true });
  });

  it('command_output: drops command and tool output bodies', () => {
    const { bus, written } = makeBus(['command_output']);
    bus.emit('a', RUN_ID, 'fake', {
      type: 'command.completed',
      payload: { commandId: 'c1', exitCode: 0, output: 'secret build log' },
    });
    bus.emit('a', RUN_ID, 'fake', {
      type: 'tool.result',
      payload: { toolId: 't1', ok: true, output: 'file body' },
    });
    expect(written[0]?.payload).not.toHaveProperty('output');
    expect(written[1]?.payload).not.toHaveProperty('output');
  });

  it('paths: strips the workspace and command cwd', () => {
    const { bus, written } = makeBus(['paths']);
    bus.emit('a', RUN_ID, 'fake', {
      type: 'run.started',
      payload: { side: 'a', agent: 'fake', harness: 'vanilla', workspace: '/home/me/ws' },
    });
    bus.emit('a', RUN_ID, 'fake', {
      type: 'command.started',
      payload: { commandId: 'c1', command: 'ls', cwd: '/home/me/ws' },
    });
    expect(written[0]?.payload).not.toHaveProperty('workspace');
    expect(written[1]?.payload).not.toHaveProperty('cwd');
    expect((written[1]?.payload as { command: string }).command).toBe('ls');
  });

  it('file_contents: drops write inputs and read outputs, keeps command tools', () => {
    const { bus, written } = makeBus(['file_contents']);
    bus.emit('a', RUN_ID, 'fake', {
      type: 'tool.called',
      payload: { toolId: 't1', name: 'Write', input: { path: 'a.js', content: 'body' } },
    });
    bus.emit('a', RUN_ID, 'fake', {
      type: 'tool.called',
      payload: { toolId: 't2', name: 'Bash', input: { command: 'ls' } },
    });
    bus.emit('a', RUN_ID, 'fake', {
      type: 'tool.result',
      payload: { toolId: 't1', name: 'Read', ok: true, output: 'body' },
    });
    expect(written[0]?.payload).not.toHaveProperty('input');
    expect(written[1]?.payload).toHaveProperty('input');
    expect(written[2]?.payload).not.toHaveProperty('output');
  });
});

describe('size limits', () => {
  it('truncates oversized strings and flags it', () => {
    const { bus, written } = makeBus();
    const huge = 'x'.repeat(EVENT_LIMITS.maxStringBytes * 2);
    bus.emit('a', RUN_ID, 'fake', output(huge));
    const payload = written[0]?.payload as { text: string; truncated?: boolean };
    expect(Buffer.byteLength(payload.text, 'utf8')).toBe(EVENT_LIMITS.maxStringBytes);
    expect(payload.truncated).toBe(true);
  });

  it('drops the largest payload field when the event is still too big', () => {
    const { bus, written } = makeBus();
    const chunk = 'y'.repeat(EVENT_LIMITS.maxStringBytes);
    bus.emit('a', RUN_ID, 'fake', {
      type: 'tool.called',
      payload: { toolId: 't1', name: 'Bash', input: { a: chunk, b: chunk, c: chunk, d: chunk, e: chunk } },
    });
    expect(written[0]?.payload).toMatchObject({ input: '[dropped: too large]' });
    expect(Buffer.byteLength(JSON.stringify(written[0]), 'utf8')).toBeLessThanOrEqual(
      EVENT_LIMITS.maxEventBytes,
    );
  });
});
