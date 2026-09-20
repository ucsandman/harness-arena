import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStateStore } from '@harness-arena/core';
import { callTool, connect, removeDir, tempDir, type Connected } from './helpers.js';

/**
 * The two challenge tools against an injected fetch: no server, no network, no battle. What is
 * asserted is the refusal when this machine is not logged in, the request the tool builds, and that
 * the device token never appears in anything a client can read.
 */

const SERVER = 'https://arena.example';
const TOKEN = 'tok_test';

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

function fakeServer(answer: (call: Call) => { status?: number; body: unknown }): {
  fetchImpl: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
      auth: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const result = answer(call);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const CHALLENGE = {
  id: 'chl_0000000000000001',
  title: 'superclaude vs vanilla',
  description: null,
  status: 'open',
  createdBy: { id: 'usr_1', login: 'creator' },
  sides: {
    a: { label: 'superclaude', harness: { source: 'https://github.com/acme/superclaude', trusted: false } },
    b: { label: 'vanilla', harness: { source: 'vanilla', trusted: false } },
  },
  agent: { id: 'fake' },
  target: {
    kind: 'task',
    category: 'overall',
    task: { kind: 'prompt', prompt: 'Fix the parser.' },
    repository: { source: 'empty', submodules: false },
    evaluation: { assertions: [], efficiency: {}, judge: { enabled: false } },
    limits: { timeoutMs: 1_200_000, maxOutputBytes: 52_428_800 },
  },
  privacy: { upload: 'metrics', exclude: [], redact: true },
  visibility: 'public',
  ratingEligible: true,
  battleIds: ['btl_0000000000000001'],
  acceptedBy: null,
  createdAt: '2026-09-19T10:00:00.000Z',
  expiresAt: null,
  completedAt: null,
};

const RESPONSE_BODY = {
  challenge: CHALLENGE,
  url: SERVER + '/challenges/' + CHALLENGE.id,
  note: 'Arena hosts no runner.',
};

let home: string;
let session: Connected | null = null;

beforeEach(() => {
  home = tempDir('challenges');
});

afterEach(async () => {
  if (session) await session.close();
  session = null;
  removeDir(home);
});

async function login(): Promise<void> {
  await createStateStore(home).setConfig({ token: TOKEN, serverUrl: SERVER });
}

describe('challenge tools', () => {
  it('are listed, and say that execution happens locally', async () => {
    session = await connect({ home, deps: { exampleHarnessDir: null } });
    const listed = await session.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    expect(byName.has('arena_create_challenge')).toBe(true);
    expect(byName.has('arena_get_challenge')).toBe(true);
    expect(byName.get('arena_create_challenge')?.description).toContain('executed locally');
    expect(byName.get('arena_get_challenge')?.description).toContain('executed locally');
    expect(byName.get('arena_create_challenge')?.description).toContain('arena challenge run');
  });

  it('refuse without a login and name `arena login`', async () => {
    const server = fakeServer(() => ({ body: RESPONSE_BODY }));
    session = await connect({ home, deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl } });

    const read = await callTool(session.client, 'arena_get_challenge', { id: CHALLENGE.id });
    expect(read.isError).toBe(true);
    expect(read.text).toContain('arena login');

    const created = await callTool(session.client, 'arena_create_challenge', {
      title: 'x',
      harnessA: 'vanilla',
      harnessB: 'vanilla',
      agentId: 'fake',
      prompt: 'do it',
      repository: 'empty',
    });
    expect(created.isError).toBe(true);
    expect(created.text).toContain('arena login');
    // nothing was sent anywhere
    expect(server.calls).toHaveLength(0);
  });

  it('create posts the definition and returns the id without running anything', async () => {
    const server = fakeServer(() => ({ status: 201, body: RESPONSE_BODY }));
    await login();
    session = await connect({ home, deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl } });

    const answer = await callTool(session.client, 'arena_create_challenge', {
      title: 'superclaude vs vanilla',
      harnessA: 'https://github.com/acme/superclaude',
      harnessB: 'vanilla',
      agentId: 'fake',
      prompt: 'Fix the parser.',
      repository: 'empty',
    });

    expect(answer.isError).toBe(false);
    expect(answer.data.id).toBe(CHALLENGE.id);
    expect(answer.data.runLocallyWith).toBe('arena challenge run ' + CHALLENGE.id);
    expect(answer.summary).toContain('Nothing has run');

    const call = server.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(SERVER + '/api/v1/challenges');
    expect(call?.auth).toBe('Bearer ' + TOKEN);
    const body = call?.body as {
      sides: { a: { harness: { source: string } } };
      agent: { id: string };
      target: { kind: string };
    };
    expect(body.sides.a.harness.source).toBe('https://github.com/acme/superclaude');
    expect(body.agent.id).toBe('fake');
    expect(body.target.kind).toBe('task');
    expect(answer.text).not.toContain(TOKEN);
  });

  it('create refuses two targets at once, and no target at all', async () => {
    const server = fakeServer(() => ({ status: 201, body: RESPONSE_BODY }));
    await login();
    session = await connect({ home, deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl } });

    const both = await callTool(session.client, 'arena_create_challenge', {
      title: 'x',
      harnessA: 'vanilla',
      harnessB: 'vanilla',
      agentId: 'fake',
      prompt: 'do it',
      repository: 'empty',
      benchmarkSlug: 'acme-pack',
      benchmarkVersionId: 'bmv_0123456789abcdef01234567',
    });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('exactly one target');

    const neither = await callTool(session.client, 'arena_create_challenge', {
      title: 'x',
      harnessA: 'vanilla',
      harnessB: 'vanilla',
      agentId: 'fake',
    });
    expect(neither.isError).toBe(true);
    expect(server.calls).toHaveLength(0);
  });

  it('get reads one challenge and reports its linked battles', async () => {
    const server = fakeServer(() => ({ body: RESPONSE_BODY }));
    await login();
    session = await connect({ home, deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl } });

    const answer = await callTool(session.client, 'arena_get_challenge', { id: CHALLENGE.id });
    expect(answer.isError).toBe(false);
    expect(answer.data.challenge.id).toBe(CHALLENGE.id);
    expect(answer.data.challenge.battleIds).toEqual(['btl_0000000000000001']);
    expect(answer.summary).toContain('1 linked battle');
    expect(server.calls[0]?.url).toBe(SERVER + '/api/v1/challenges/' + CHALLENGE.id);
    expect(answer.text).not.toContain(TOKEN);
  });

  it('get turns a 404 into a sentence naming the server', async () => {
    const server = fakeServer(() => ({
      status: 404,
      body: { error: { code: 'not_found', message: 'no challenge with that id is visible to you' } },
    }));
    await login();
    session = await connect({ home, deps: { exampleHarnessDir: null, fetchImpl: server.fetchImpl } });

    const answer = await callTool(session.client, 'arena_get_challenge', { id: 'chl_missing000000' });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(SERVER);
  });
});
