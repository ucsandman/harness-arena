import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METRIC_KEYS } from '@harness-arena/protocol';
import { jsonResult } from '../src/result.js';
import { TOOL_NAMES } from '../src/server.js';
import { EVENT_CAP } from '../src/tools/index.js';
import {
  callTool,
  connect,
  removeDir,
  REPO_ROOT,
  seedExportedBattle,
  tempDir,
  type Connected,
} from './helpers.js';

let home: string;
let session: Connected;
let battleId: string;
let eventCount: number;

beforeAll(async () => {
  home = tempDir('read');
  const seeded = seedExportedBattle(home);
  battleId = seeded.id;
  eventCount = seeded.events;
  session = await connect({ home, deps: { exampleHarnessDir: null } });
});

afterAll(async () => {
  await session.close();
  removeDir(home);
});

describe('tool surface', () => {
  it('advertises every tool with an object input schema', async () => {
    const listed = await session.client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(listed.tools).toHaveLength(TOOL_NAMES.length);

    for (const tool of listed.tools) {
      expect(tool.description, tool.name + ' needs a description').toBeTruthy();
      expect((tool.description ?? '').length, tool.name + ' description is too short').toBeGreaterThan(200);
      expect(tool.inputSchema, tool.name + ' needs an input schema').toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }

    const byName = new Map(listed.tools.map((t) => [t.name, t]));
    const getBattle = byName.get('arena_get_battle');
    expect(Object.keys(getBattle?.inputSchema.properties ?? {}).sort()).toEqual([
      'afterSeq',
      'eventTypes',
      'id',
      'includeEvents',
      'limit',
    ]);
    const start = byName.get('arena_start_battle');
    expect(Object.keys(start?.inputSchema.properties ?? {}).sort()).toEqual([
      'spec',
      'specPath',
      'trust',
      'waitMs',
    ]);
  });

  it('reports the server identity and instructions', async () => {
    const info = session.client.getServerVersion();
    expect(info?.name).toBe('harness-arena');
    expect(session.client.getInstructions()).toContain('never reads provider credentials');
  });
});

describe('arena_list_agents', () => {
  it('lists every adapter with its capabilities', async () => {
    const answer = await callTool(session.client, 'arena_list_agents');
    expect(answer.isError).toBe(false);
    expect(answer.data.count).toBeGreaterThanOrEqual(5);

    const ids = answer.data.agents.map((a: { id: string }) => a.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('codex');
    expect(ids).toContain('fake');

    const fake = answer.data.agents.find((a: { id: string }) => a.id === 'fake');
    expect(fake.installed).toBe(true);
    expect(fake.kind).toBe('fake');
    expect(fake.capabilities.tokens).toBe('observed');
    expect(typeof fake.capabilities.userConfigIsolation).toBe('boolean');
    expect(answer.summary).toContain('installed');
  });
});

describe('arena_list_battles', () => {
  it('returns the seeded battle newest first', async () => {
    const answer = await callTool(session.client, 'arena_list_battles', { limit: 5 });
    expect(answer.isError).toBe(false);
    expect(answer.data.count).toBe(1);
    expect(answer.data.running).toBeNull();
    expect(answer.data.battles[0].id).toBe(battleId);
    expect(answer.data.battles[0].demo).toBe(true);
    expect(answer.data.battles[0].status).toBe('completed');
  });
});

describe('arena_get_battle', () => {
  it('returns the record without events by default', async () => {
    const answer = await callTool(session.client, 'arena_get_battle', { id: battleId });
    expect(answer.isError).toBe(false);
    expect(answer.data.record.id).toBe(battleId);
    expect(answer.data.record.runs.a.label).toBe('Agnostic AI');
    expect(answer.data.events.included).toBe(false);
    expect(answer.data.running).toBe(false);
  });

  it('includes events and flags truncation', async () => {
    const answer = await callTool(session.client, 'arena_get_battle', {
      id: battleId,
      includeEvents: true,
      limit: 5,
    });
    expect(answer.data.events.included).toBe(true);
    expect(answer.data.events.total).toBe(eventCount);
    expect(answer.data.events.returned).toBe(5);
    expect(answer.data.events.truncated).toBe(true);
    expect(answer.data.events.cap).toBe(5);
    expect(answer.data.events.items).toHaveLength(5);
    expect(answer.data.events.items[0].type).toBe('battle.started');
    expect(answer.summary).toContain('truncated');
  });

  it('pages forward with afterSeq so the tail of a long stream is reachable', async () => {
    const first = await callTool(session.client, 'arena_get_battle', {
      id: battleId,
      includeEvents: true,
      limit: 5,
    });
    const firstItems = first.data.events.items as Array<{ seq: number }>;
    expect(first.data.events.afterSeq).toBeNull();
    expect(first.data.events.nextAfterSeq).toBe(firstItems[4]?.seq);

    const next = await callTool(session.client, 'arena_get_battle', {
      id: battleId,
      includeEvents: true,
      limit: 5,
      afterSeq: first.data.events.nextAfterSeq,
    });
    const nextItems = next.data.events.items as Array<{ seq: number }>;
    expect(nextItems).toHaveLength(5);
    expect(nextItems[0]?.seq).toBeGreaterThan(firstItems[4]?.seq as number);
    expect(next.data.events.afterSeq).toBe(first.data.events.nextAfterSeq);
    expect(next.data.events.total).toBe(eventCount - firstItems.length);

    const tail = await callTool(session.client, 'arena_get_battle', {
      id: battleId,
      includeEvents: true,
      afterSeq: eventCount,
    });
    expect(tail.data.events.items).toEqual([]);
    expect(tail.data.events.truncated).toBe(false);
    // a poll that finds nothing new keeps the caller's cursor instead of rewinding to the start
    expect(tail.data.events.nextAfterSeq).toBe(eventCount);
  });

  it('filters by event type and reports no truncation when everything fits', async () => {
    const answer = await callTool(session.client, 'arena_get_battle', {
      id: battleId,
      includeEvents: true,
      eventTypes: ['run.started', 'run.completed'],
      limit: EVENT_CAP,
    });
    const items = answer.data.events.items as Array<{ type: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((e) => e.type))).toEqual(new Set(['run.started', 'run.completed']));
    expect(answer.data.events.matched).toBe(items.length);
    expect(answer.data.events.truncated).toBe(false);
    expect(answer.data.events.total).toBe(eventCount);
  });

  it('errors on an unknown id', async () => {
    const answer = await callTool(session.client, 'arena_get_battle', { id: 'btl_doesnotexist0' });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('no battle btl_doesnotexist0');
  });
});

describe('arena_get_results', () => {
  it('returns the verdict, evaluation and insights', async () => {
    const answer = await callTool(session.client, 'arena_get_results', { id: battleId });
    expect(answer.isError).toBe(false);
    expect(answer.data.verdict.winner).toBe('tie');
    expect(answer.data.verdict.method).toBe('deterministic');
    expect(answer.data.insights.length).toBeGreaterThan(0);
    expect(answer.data.insightsSource).toBe('record');
    expect(answer.data.evaluation.comparisons.length).toBe(METRIC_KEYS.length);
    expect(answer.data.demo).toBe(true);
    expect(answer.summary).toContain('Demo data');
  });
});

describe('arena_compare_runs', () => {
  it('pairs every metric and reports unavailable values as n/a, never 0', async () => {
    const answer = await callTool(session.client, 'arena_compare_runs', { id: battleId });
    expect(answer.isError).toBe(false);
    const rows = answer.data.rows as Array<{
      key: string;
      label: string;
      a: { value: unknown; status: string; badge: string; display: string };
      b: { value: unknown; status: string; badge: string; display: string };
      better: string;
      significance: string;
    }>;
    expect(rows).toHaveLength(METRIC_KEYS.length);

    const unavailable = rows.flatMap((r) => [r.a, r.b]).filter((c) => c.status === 'unavailable');
    expect(unavailable.length, 'the fixture must contain at least one unavailable metric').toBeGreaterThan(0);
    for (const cell of unavailable) {
      expect(cell.value).toBeNull();
      expect(cell.display).toBe('n/a');
      expect(cell.badge).toBe('n/a');
    }

    const cacheWrite = rows.find((r) => r.key === 'tokens_cache_write');
    expect(cacheWrite?.a.display).toBe('n/a');
    expect(cacheWrite?.better).toBe('n/a');

    const duration = rows.find((r) => r.key === 'duration_ms');
    expect(duration?.a.status).not.toBe('unavailable');
    expect(duration?.a.display).toMatch(/seconds|ms|minutes/);
    expect(['a', 'b']).toContain(duration?.better);

    expect(answer.data.labels).toEqual({ a: 'Agnostic AI', b: 'Vanilla Claude Code' });
    expect(answer.data.winner).toBe('tie');
    expect(answer.summary).toContain('n/a');
  });
});

describe('arena_render_report', () => {
  it('writes a self-contained report to an explicit path', async () => {
    const out = path.join(home, 'out', 'battle-report.html');
    const answer = await callTool(session.client, 'arena_render_report', { id: battleId, outPath: out });
    expect(answer.isError).toBe(false);
    expect(answer.data.path).toBe(out);
    expect(fs.existsSync(out)).toBe(true);
    const html = fs.readFileSync(out, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Agnostic AI');
    expect(answer.data.bytes).toBe(Buffer.byteLength(html, 'utf8'));
    expect(answer.data.events).toBe(eventCount);
  });

  it('defaults to the battle directory and refuses a non-html path', async () => {
    const answer = await callTool(session.client, 'arena_render_report', { id: battleId });
    expect(answer.data.path).toBe(path.join(home, 'battles', battleId, 'report.html'));
    expect(fs.existsSync(answer.data.path)).toBe(true);

    const bad = await callTool(session.client, 'arena_render_report', {
      id: battleId,
      outPath: path.join(home, 'nope.txt'),
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('ending in .html');
  });

  it('never overwrites a file it did not write, and creates directories only under ARENA_HOME', async () => {
    const mine = path.join(home, 'site', 'index.html');
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, '<!doctype html><html><body>my own site</body></html>');

    const refused = await callTool(session.client, 'arena_render_report', {
      id: battleId,
      outPath: mine,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(mine);
    expect(fs.readFileSync(mine, 'utf8')).toContain('my own site');

    // refreshing a report this tool wrote is still allowed
    const target = path.join(home, 'site', 'report-1.html');
    const wrote = await callTool(session.client, 'arena_render_report', { id: battleId, outPath: target });
    expect(wrote.isError).toBe(false);
    const again = await callTool(session.client, 'arena_render_report', { id: battleId, outPath: target });
    expect(again.isError).toBe(false);
    expect(again.data.path).toBe(target);

    const outsideRoot = tempDir('outside');
    try {
      const outside = path.join(outsideRoot, 'nested', 'deep', 'report.html');
      const blocked = await callTool(session.client, 'arena_render_report', {
        id: battleId,
        outPath: outside,
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain('ARENA_HOME');
      expect(fs.existsSync(path.join(outsideRoot, 'nested'))).toBe(false);
    } finally {
      removeDir(outsideRoot);
    }
  });
});

describe('the payload cap', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    const small = jsonResult('ok', { text: 'thanks \u3042\u3044\u3046' });
    expect(small.isError).not.toBe(true);

    // 1.5M CJK characters: about 1.5M UTF-16 code units, about 4.5 MB of UTF-8.
    const over = jsonResult('ok', { text: '\u3042'.repeat(1_500_000) });
    expect(over.isError).toBe(true);
    const message = (over.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(message).toContain('over the');
    expect(Number(/the result is (\d+) KB/.exec(message)?.[1] ?? 0)).toBeGreaterThan(4096);
  });
});

describe('arena_inspect_harness', () => {
  it('inspects the example harness on disk without executing it', async () => {
    const dir = path.join(REPO_ROOT, 'examples', 'example-harness');
    const answer = await callTool(session.client, 'arena_inspect_harness', { source: dir });
    expect(answer.isError).toBe(false);
    expect(answer.data.mode).toBe('local');
    expect(answer.data.name).toBe('example-harness');
    expect(answer.data.inspection.manifest.found).toBe(true);
    expect(answer.data.inspection.manifest.valid).toBe(true);
    expect(answer.data.inspection.manifest.manifest.name).toBe('example-harness');
    expect(answer.data.inspection.agents).toContain('claude-code');
    expect(answer.data.detectedFeatures).toContain('CLAUDE.md');
    expect(answer.data.detectedFeatures).toContain('Skills');
    expect(answer.data.execution.files).toEqual(['CLAUDE.md', '.claude', 'AGENTS.md']);
    expect(answer.data.execution.commands).toEqual([]);
    expect(answer.data.trustRequired).toBe(false);
    expect(answer.summary).toContain('No commands declared');
  });

  it('reports a harness that declares commands as needing trust', async () => {
    const dir = tempDir('harness');
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# rules\n');
      fs.writeFileSync(
        path.join(dir, 'arena.yaml'),
        [
          'arena: 1',
          'name: needs-trust',
          'files:',
          '  - AGENTS.md',
          'install:',
          '  command: npm ci',
          '',
        ].join('\n'),
      );
      const answer = await callTool(session.client, 'arena_inspect_harness', { source: dir });
      expect(answer.data.trustRequired).toBe(true);
      expect(answer.data.execution.commands).toEqual(['npm ci']);
      expect(answer.summary).toContain('Needs trust');
    } finally {
      removeDir(dir);
    }
  });

  it('masks arena.yaml agentConfig credential values and keeps the names', async () => {
    const dir = tempDir('harness-secret');
    const name = ['ANTHROPIC', 'API', 'KEY'].join('_');
    const planted = ['arena', 'placeholder', 'credential', '000111'].join('-');
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# rules\n');
      fs.writeFileSync(
        path.join(dir, 'arena.yaml'),
        [
          'arena: 1',
          'name: secret-harness',
          'files:',
          '  - AGENTS.md',
          'agentConfig:',
          '  claude-code:',
          '    env:',
          '      ' + name + ': ' + planted,
          '',
        ].join('\n'),
      );
      const answer = await callTool(session.client, 'arena_inspect_harness', { source: dir });
      expect(answer.isError).toBe(false);
      expect(answer.data.inspection.manifest.valid).toBe(true);
      const masked = answer.data.inspection.manifest.manifest.agentConfig['claude-code'].env;
      expect(Object.keys(masked)).toEqual([name]);
      expect(masked[name]).toBe('[REDACTED]');
      expect(answer.text).not.toContain(planted);
    } finally {
      removeDir(dir);
    }
  });

  it('inspects vanilla and rejects a plain git URL', async () => {
    const vanilla = await callTool(session.client, 'arena_inspect_harness', { source: 'vanilla' });
    expect(vanilla.data.mode).toBe('vanilla');
    expect(vanilla.data.trustRequired).toBe(false);

    const git = await callTool(session.client, 'arena_inspect_harness', {
      source: 'git@gitlab.com:someone/harness.git',
    });
    expect(git.isError).toBe(true);
    expect(git.text).toContain('clone');
  });

  it('inspects a GitHub harness through an injected fetch, with no clone', async () => {
    const calls: string[] = [];
    const files = [
      { path: 'CLAUDE.md', type: 'blob' },
      { path: 'arena.yaml', type: 'blob' },
    ];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return new Response(JSON.stringify({ tree: files, truncated: false }), { status: 200 });
      }
      if (url.includes('/contents/arena.yaml')) {
        return new Response('arena: 1\nname: remote-harness\nfiles:\n  - CLAUDE.md\n', { status: 200 });
      }
      if (url.includes('/contents/CLAUDE.md')) return new Response('# rules\n', { status: 200 });
      if (url.includes('/repos/acme/harness')) {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const remote = await connect({ home, deps: { fetchImpl, exampleHarnessDir: null } });
    try {
      const answer = await callTool(remote.client, 'arena_inspect_harness', {
        source: 'https://github.com/acme/harness',
      });
      expect(answer.isError).toBe(false);
      expect(answer.data.mode).toBe('github');
      expect(answer.data.name).toBe('remote-harness');
      expect(answer.data.ref).toBe('main');
      expect(answer.data.detectedFeatures).toContain('CLAUDE.md');
      expect(calls.every((url) => url.startsWith('https://api.github.com/'))).toBe(true);
    } finally {
      await remote.close();
    }
  });
});

describe('arena_list_harnesses', () => {
  it('reports an empty cache and finds the bundled example harness', async () => {
    const empty = await callTool(session.client, 'arena_list_harnesses');
    expect(empty.data.count).toBe(0);
    expect(empty.data.example).toBeNull();
    expect(empty.data.harnessesDir).toBe(path.join(home, 'harnesses'));

    const withExample = await connect({ home });
    try {
      const answer = await callTool(withExample.client, 'arena_list_harnesses');
      expect(answer.data.example.name).toBe('example-harness');
      expect(answer.data.example.trustRequired).toBe(false);
      expect(answer.summary).toContain('example harness at');
    } finally {
      await withExample.close();
    }
  });

  it('inspects a cached checkout and names its remote', async () => {
    const key = 'a'.repeat(40);
    const dir = path.join(home, 'harnesses', key);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme/cached-harness.git\n',
    );
    fs.writeFileSync(path.join(dir, 'arena.yaml'), 'arena: 1\nname: cached-harness\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# cached\n');
    try {
      const answer = await callTool(session.client, 'arena_list_harnesses');
      expect(answer.data.count).toBe(1);
      const entry = answer.data.cached[0];
      expect(entry.cacheKey).toBe(key);
      expect(entry.name).toBe('cached-harness');
      expect(entry.remote).toBe('https://github.com/acme/cached-harness.git');
      expect(entry.trustRequired).toBe(false);
      expect(entry.detectedFeatures).toContain('CLAUDE.md');
    } finally {
      removeDir(dir);
    }
  });
});
