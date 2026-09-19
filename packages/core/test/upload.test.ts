import { describe, expect, it } from 'vitest';
import { EVENT_LIMITS, battleSpecSchema, privacySettingsSchema } from '@harness-arena/protocol';
import type { ArenaEvent, BattleRecord, PrivacySettings } from '@harness-arena/protocol';
import { createEventBus } from '../src/events.js';
import { createPassthroughRedactor } from '../src/redact.js';
import { createUploader, sanitizeRecordForUpload } from '../src/upload.js';
import { makeRecord, silentLogger } from './helpers.js';

const SPEC = battleSpecSchema.parse({
  version: 1,
  task: { kind: 'prompt', prompt: 'Fix it.' },
  repository: { source: 'empty' },
  competitors: {
    a: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
    b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
  },
});

function recordWithArtifacts(): BattleRecord {
  return makeRecord({
    spec: SPEC,
    a: {
      artifacts: {
        diff: 'diff --git a/x b/x',
        diffBytes: 19,
        finalResponse: 'all done',
        rawLogPath: 'C:/Users/someone/.harness-arena/battles/x/runs/a/raw.log',
        changedFiles: [{ path: 'src/x.js', kind: 'modify', linesAdded: 1, linesRemoved: 1 }],
      },
    },
  });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(responder: (call: Call, index: number) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const { status, body } = responder(call, calls.length - 1);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function privacy(patch: Partial<PrivacySettings>): PrivacySettings {
  return privacySettingsSchema.parse(patch);
}

function validEvents(count: number): ArenaEvent[] {
  const out: ArenaEvent[] = [];
  const bus = createEventBus({
    battleId: 'btl_0000000000000abc',
    startedAt: 0,
    redactor: createPassthroughRedactor(),
    privacy: privacy({}),
    sink: (event) => out.push(event),
    now: () => 1000,
  });
  for (let i = 0; i < count; i++)
    bus.emit('a', 'run_0000000000000abc', 'fake', { type: 'agent.thinking', payload: { chars: i } });
  return out;
}

describe('privacy level none', () => {
  it('is a no-op uploader that never touches the network', async () => {
    const { calls, impl } = stubFetch(() => ({ status: 200 }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 'device-token',
      privacy: privacy({ upload: 'none' }),
      logger: silentLogger(),
      fetchImpl: impl,
    });
    expect(await uploader.createBattle(recordWithArtifacts())).toBeNull();
    await uploader.pushEvents('btl_0000000000000abc', validEvents(3));
    await uploader.patchRecord('btl_0000000000000abc', recordWithArtifacts());
    await uploader.uploadArtifact('btl_0000000000000abc', 'a', 'diff', 'x');
    await uploader.flush();
    expect(calls).toHaveLength(0);
    expect(uploader.stats().skipped).toBe(4);
    expect(uploader.stats().failures).toBe(0);
  });
});

describe('createBattle', () => {
  it('posts the record with a bearer token and a versioned user agent', async () => {
    const { calls, impl } = stubFetch(() => ({
      status: 201,
      body: {
        id: 'btl_0000000000000abc',
        url: 'https://arena.test/b/1',
        streamUrl: 'https://arena.test/b/1/stream',
      },
    }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test/',
      token: 'device-token',
      privacy: privacy({ upload: 'full' }),
      logger: silentLogger(),
      fetchImpl: impl,
      arenaVersion: '1.2.3',
    });
    const created = await uploader.createBattle(recordWithArtifacts());
    expect(created?.url).toBe('https://arena.test/b/1');
    expect(calls[0]?.url).toBe('https://arena.test/api/v1/battles');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.authorization).toBe('Bearer device-token');
    expect(calls[0]?.headers['user-agent']).toBe('harness-arena/1.2.3');
    expect(uploader.stats().records).toBe(1);
  });

  it('returns null when the server answers with something unexpected', async () => {
    const { impl } = stubFetch(() => ({ status: 200, body: { nope: true } }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 't',
      privacy: privacy({ upload: 'full' }),
      logger: silentLogger(),
      fetchImpl: impl,
    });
    expect(await uploader.createBattle(recordWithArtifacts())).toBeNull();
    expect(uploader.stats().failures).toBe(1);
  });
});

describe('pushEvents', () => {
  it('splits events into batches of at most maxBatchEvents', async () => {
    const { calls, impl } = stubFetch(() => ({
      status: 200,
      body: { accepted: 1, rejected: 0, lastSeq: 1, capped: false },
    }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 't',
      privacy: privacy({ upload: 'events' }),
      logger: silentLogger(),
      fetchImpl: impl,
    });
    await uploader.pushEvents('btl_0000000000000abc', validEvents(EVENT_LIMITS.maxBatchEvents + 1));
    await uploader.flush();
    expect(calls).toHaveLength(2);
    expect((calls[0]?.body as { events: unknown[] }).events).toHaveLength(EVENT_LIMITS.maxBatchEvents);
    expect((calls[1]?.body as { events: unknown[] }).events).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://arena.test/api/v1/battles/btl_0000000000000abc/events');
    expect(uploader.stats().batches).toBe(2);
    expect(uploader.stats().events).toBe(EVENT_LIMITS.maxBatchEvents + 1);
  });

  it('skips events entirely at the metrics level', async () => {
    const { calls, impl } = stubFetch(() => ({ status: 200 }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 't',
      privacy: privacy({ upload: 'metrics' }),
      logger: silentLogger(),
      fetchImpl: impl,
    });
    await uploader.pushEvents('btl_0000000000000abc', validEvents(5));
    await uploader.flush();
    expect(calls).toHaveLength(0);
    expect(uploader.stats().skipped).toBe(5);
  });

  it('retries a 500 three times and never throws', async () => {
    const { calls, impl } = stubFetch(() => ({ status: 500 }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 't',
      privacy: privacy({ upload: 'events' }),
      logger: silentLogger(),
      fetchImpl: impl,
      retryBaseMs: 0,
    });
    await expect(uploader.pushEvents('btl_0000000000000abc', validEvents(2))).resolves.toBeUndefined();
    await uploader.flush();
    expect(calls).toHaveLength(3);
    expect(uploader.stats().failures).toBe(1);
    expect(uploader.stats().events).toBe(0);
  });

  it('does not retry a 4xx', async () => {
    const { calls, impl } = stubFetch(() => ({ status: 403 }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 't',
      privacy: privacy({ upload: 'events' }),
      logger: silentLogger(),
      fetchImpl: impl,
      retryBaseMs: 0,
    });
    await uploader.pushEvents('btl_0000000000000abc', validEvents(1));
    await uploader.flush();
    expect(calls).toHaveLength(1);
    expect(uploader.stats().failures).toBe(1);
  });

  it('survives a network error', async () => {
    let count = 0;
    const impl = (async () => {
      count += 1;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 't',
      privacy: privacy({ upload: 'events' }),
      logger: silentLogger(),
      fetchImpl: impl,
      retryBaseMs: 0,
    });
    await uploader.pushEvents('btl_0000000000000abc', validEvents(1));
    await uploader.flush();
    expect(count).toBe(3);
    expect(uploader.stats().failures).toBe(1);
  });
});

describe('privacy filtering', () => {
  it('sanitizeRecordForUpload strips artifacts the level or exclusions forbid', () => {
    const full = sanitizeRecordForUpload(recordWithArtifacts(), privacy({ upload: 'full' }));
    expect(full.runs.a.artifacts.diff).toBe('diff --git a/x b/x');
    expect(full.runs.a.artifacts.finalResponse).toBe('all done');
    expect(full.runs.a.artifacts.rawLogPath).toBeUndefined();

    const excluded = sanitizeRecordForUpload(
      recordWithArtifacts(),
      privacy({ upload: 'full', exclude: ['diffs'] }),
    );
    expect(excluded.runs.a.artifacts.diff).toBeNull();
    expect(excluded.runs.a.artifacts.diffBytes).toBeUndefined();

    const metricsOnly = sanitizeRecordForUpload(recordWithArtifacts(), privacy({ upload: 'metrics' }));
    expect(metricsOnly.runs.a.artifacts.diff).toBeNull();
    expect(metricsOnly.runs.a.artifacts.finalResponse).toBeNull();

    const noPaths = sanitizeRecordForUpload(
      recordWithArtifacts(),
      privacy({ upload: 'full', exclude: ['paths'] }),
    );
    expect(noPaths.runs.a.artifacts.changedFiles[0]?.path).toBe('[excluded]');
  });

  it('never sends a diff when diffs are excluded, in the record or as an artifact', async () => {
    const { calls, impl } = stubFetch(() => ({ status: 200, body: {} }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 't',
      privacy: privacy({ upload: 'full', exclude: ['diffs'] }),
      logger: silentLogger(),
      fetchImpl: impl,
    });
    await uploader.patchRecord('btl_0000000000000abc', recordWithArtifacts());
    await uploader.uploadArtifact('btl_0000000000000abc', 'a', 'diff', 'diff --git a/x b/x');
    await uploader.uploadArtifact('btl_0000000000000abc', 'a', 'final_response', 'all done');
    await uploader.flush();
    expect(calls.map((c) => c.url)).toEqual([
      'https://arena.test/api/v1/battles/btl_0000000000000abc',
      'https://arena.test/api/v1/battles/btl_0000000000000abc/artifacts',
    ]);
    expect(JSON.stringify(calls[0]?.body)).not.toContain('diff --git');
    expect((calls[1]?.body as { kind: string }).kind).toBe('final_response');
    expect(uploader.stats().artifacts).toBe(1);
  });

  it('replaces agent env VALUES with [REDACTED] at every level, keeping the names', () => {
    const key = ['sk', '-live-', 'abcdefghijklmnop'].join('');
    const spec = battleSpecSchema.parse({
      version: 1,
      task: { kind: 'prompt', prompt: 'Fix it.' },
      repository: { source: 'empty' },
      competitors: {
        a: { agent: { id: 'fake', env: { MY_KEY: key } }, harness: { source: 'vanilla' } },
        b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
      },
    });
    for (const level of ['metrics', 'events', 'full'] as const) {
      const clean = sanitizeRecordForUpload(makeRecord({ spec }), privacy({ upload: level }));
      const body = JSON.stringify(clean);
      expect(body, level).not.toContain(key);
      expect(body, level).toContain('MY_KEY');
      expect(clean.spec.competitors.a.agent.env).toEqual({ MY_KEY: '[REDACTED]' });
    }
  });

  it('excludes the task prompt at the metrics level and whenever prompts are excluded', () => {
    const record = recordWithArtifacts();
    const metricsOnly = sanitizeRecordForUpload(record, privacy({ upload: 'metrics' }));
    expect(metricsOnly.task.prompt).toBe('[excluded]');
    expect(metricsOnly.task.title).toBe('Fix the session-expiry bug');
    expect(metricsOnly.task.source).toEqual({ kind: 'prompt' });
    expect(metricsOnly.spec.task.kind === 'prompt' ? metricsOnly.spec.task.prompt : null).toBe('[excluded]');

    const noPrompts = sanitizeRecordForUpload(record, privacy({ upload: 'full', exclude: ['prompts'] }));
    expect(noPrompts.task.prompt).toBe('[excluded]');
    expect(noPrompts.spec.task.kind === 'prompt' ? noPrompts.spec.task.prompt : null).toBe('[excluded]');

    const full = sanitizeRecordForUpload(record, privacy({ upload: 'full' }));
    expect(full.task.prompt).toBe('Fix it.');
  });

  it('never puts the task prompt on the wire at the metrics level', async () => {
    const { calls, impl } = stubFetch(() => ({ status: 200, body: {} }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 't',
      privacy: privacy({ upload: 'metrics' }),
      logger: silentLogger(),
      fetchImpl: impl,
    });
    await uploader.patchRecord('btl_0000000000000abc', recordWithArtifacts());
    await uploader.flush();
    expect(calls).toHaveLength(1);
    const body = JSON.stringify(calls[0]?.body);
    expect(body).not.toContain('Fix it.');
    expect(body).toContain('[excluded]');
  });

  it('skips artifacts below the full level', async () => {
    const { calls, impl } = stubFetch(() => ({ status: 200, body: {} }));
    const uploader = createUploader({
      serverUrl: 'https://arena.test',
      token: 't',
      privacy: privacy({ upload: 'events' }),
      logger: silentLogger(),
      fetchImpl: impl,
    });
    await uploader.uploadArtifact('btl_0000000000000abc', 'a', 'diff', 'x');
    await uploader.flush();
    expect(calls).toHaveLength(0);
    expect(uploader.stats().skipped).toBe(1);
  });
});
