import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSilentLogger, runDemoBattle } from '@harness-arena/core';
import { METRIC_KEYS } from '@harness-arena/protocol';
import {
  callTool,
  connect,
  removeDir,
  REPO_ROOT,
  tempDir,
  waitForStatus,
  type Connected,
} from './helpers.js';

/**
 * The live half of the suite: a real demo battle through core (deterministic fake adapters, no model
 * spend, no network) read back through the MCP tools, then arena_start_battle end to end including the
 * one-battle guard and a harness whose commands are refused because trust was not granted.
 */

const QUICK_SPEC = path.join(REPO_ROOT, 'examples', 'battles', 'fake-quick.json');

let home: string;
let session: Connected;
let demoId: string;

beforeAll(async () => {
  home = tempDir('battles');
  const record = await runDemoBattle({ home, logger: createSilentLogger() });
  demoId = record.id;
  session = await connect({ home, deps: { exampleHarnessDir: null } });
}, 180_000);

afterAll(async () => {
  await session.close();
  removeDir(home);
});

describe('a demo battle read through the tools', () => {
  it('lists it', async () => {
    const answer = await callTool(session.client, 'arena_list_battles');
    expect(answer.isError).toBe(false);
    expect(answer.data.battles.map((b: { id: string }) => b.id)).toContain(demoId);
    expect(answer.data.battles[0].demo).toBe(true);
  });

  it('returns the record with and without events, and flags truncation', async () => {
    const plain = await callTool(session.client, 'arena_get_battle', { id: demoId });
    expect(plain.data.record.status).toBe('completed');
    expect(plain.data.record.runs.b.label).toBe('Vanilla Claude Code');
    expect(plain.data.events.included).toBe(false);

    const withEvents = await callTool(session.client, 'arena_get_battle', {
      id: demoId,
      includeEvents: true,
      limit: 10,
    });
    expect(withEvents.data.events.total).toBeGreaterThan(100);
    expect(withEvents.data.events.returned).toBe(10);
    expect(withEvents.data.events.truncated).toBe(true);

    const filtered = await callTool(session.client, 'arena_get_battle', {
      id: demoId,
      includeEvents: true,
      eventTypes: ['tool.called'],
      limit: 2000,
    });
    const types = new Set((filtered.data.events.items as Array<{ type: string }>).map((event) => event.type));
    expect(types).toEqual(new Set(['tool.called']));
    expect(filtered.data.events.truncated).toBe(false);
    expect(filtered.data.events.matched).toBeLessThan(filtered.data.events.total);
  });

  it('returns results and insights', async () => {
    const answer = await callTool(session.client, 'arena_get_results', { id: demoId });
    expect(answer.data.verdict).not.toBeNull();
    expect(['a', 'b', 'tie', 'inconclusive']).toContain(answer.data.verdict.winner);
    expect(answer.data.insights.length).toBeGreaterThan(0);
    expect(answer.data.evaluation.results.length).toBeGreaterThan(0);
    expect(answer.data.demo).toBe(true);
  });

  it('compares the runs without inventing numbers', async () => {
    const answer = await callTool(session.client, 'arena_compare_runs', { id: demoId });
    const rows = answer.data.rows as Array<{
      key: string;
      a: { value: unknown; status: string; display: string };
      b: { value: unknown; status: string; display: string };
      better: string;
    }>;
    expect(rows).toHaveLength(METRIC_KEYS.length);

    const cells = rows.flatMap((row) => [row.a, row.b]);
    const unavailable = cells.filter((cell) => cell.status === 'unavailable');
    expect(unavailable.length, 'a fake run cannot report every metric').toBeGreaterThan(0);
    for (const cell of unavailable) {
      expect(cell.value).toBeNull();
      expect(cell.display).toBe('n/a');
    }
    for (const row of rows) {
      if (row.a.status === 'unavailable' || row.b.status === 'unavailable') {
        expect(row.better).toBe('n/a');
      }
    }
  });

  it('renders the report', async () => {
    const out = path.join(home, 'reports');
    fs.mkdirSync(out, { recursive: true });
    const answer = await callTool(session.client, 'arena_render_report', { id: demoId, outPath: out });
    expect(answer.data.path).toBe(path.join(out, 'report.html'));
    expect(fs.statSync(answer.data.path).size).toBeGreaterThan(10_000);
  });
});

describe('arena_start_battle', () => {
  it('rejects a bad request before running anything', async () => {
    const neither = await callTool(session.client, 'arena_start_battle', {});
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain('exactly one of spec');

    const both = await callTool(session.client, 'arena_start_battle', {
      spec: { version: 1 },
      specPath: QUICK_SPEC,
    });
    expect(both.isError).toBe(true);

    const invalid = await callTool(session.client, 'arena_start_battle', {
      spec: { version: 1, task: { kind: 'prompt', prompt: 'hi' } },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain('invalid battle spec');
    expect(invalid.text).toContain('repository');

    const missing = await callTool(session.client, 'arena_start_battle', {
      specPath: path.join(home, 'no-such-spec.json'),
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('could not read the spec file');
  });

  it('starts a spec file, refuses a second battle, and completes', async () => {
    const first = await callTool(session.client, 'arena_start_battle', {
      specPath: QUICK_SPEC,
      waitMs: 0,
    });
    expect(first.isError).toBe(false);
    expect(first.data.id).toMatch(/^btl_/);
    expect(first.data.finished).toBe(false);
    expect(first.data.trusted).toBe(false);
    expect(first.summary).toContain('poll arena_get_battle');
    expect(session.arena.runningId).toBe(first.data.id);

    const second = await callTool(session.client, 'arena_start_battle', { specPath: QUICK_SPEC });
    expect(second.isError).toBe(true);
    expect(second.text).toContain(first.data.id);
    expect(second.text).toContain('one battle runs at a time');

    const finished = await waitForStatus(session.client, first.data.id, ['completed', 'failed']);
    expect(finished.status).toBe('completed');
    expect(session.arena.runningId).toBeNull();

    const results = await callTool(session.client, 'arena_get_results', { id: first.data.id });
    expect(results.data.verdict).not.toBeNull();
    expect(results.data.demo).toBe(false);
  }, 120_000);

  it('fails a battle whose harness wants commands, without executing them', async () => {
    const harness = tempDir('untrusted-harness');
    const marker = path.join(harness, 'EXECUTED.txt');
    fs.writeFileSync(path.join(harness, 'AGENTS.md'), '# rules\n');
    // `echo x > file` behaves identically under cmd.exe and sh, so the marker is a real discriminator:
    // with trust granted this command runs and creates EXECUTED.txt in the harness directory.
    fs.writeFileSync(
      path.join(harness, 'arena.yaml'),
      [
        'arena: 1',
        'name: needs-trust',
        'files:',
        '  - AGENTS.md',
        'install:',
        '  command: echo arena-trust-probe > EXECUTED.txt',
        '',
      ].join('\n'),
    );

    try {
      const spec = JSON.parse(fs.readFileSync(QUICK_SPEC, 'utf8')) as {
        competitors: { a: { harness: { source: string } } };
      };
      spec.competitors.a.harness = { source: harness };

      const answer = await callTool(session.client, 'arena_start_battle', { spec, waitMs: 90_000 });
      expect(answer.isError).toBe(false);
      expect(answer.data.finished).toBe(true);
      expect(answer.data.status).toBe('failed');
      expect(answer.data.trusted).toBe(false);
      expect(answer.data.refusedHarnessCommands.join(' ')).toContain('EXECUTED.txt');
      expect(answer.data.error).toContain('wants to run 1 command');

      expect(fs.existsSync(marker), 'the install command must never have run').toBe(false);

      const record = await callTool(session.client, 'arena_get_battle', { id: answer.data.id });
      expect(record.data.record.status).toBe('failed');
      expect(record.data.record.runs.a.harness.executedCommands).toEqual([]);
    } finally {
      removeDir(harness);
    }
  }, 120_000);

  it('ignores harness.trusted inside the spec: only the call can grant trust', async () => {
    const harness = tempDir('spec-trusted-harness');
    const marker = path.join(harness, 'EXECUTED.txt');
    fs.writeFileSync(path.join(harness, 'AGENTS.md'), '# rules\n');
    fs.writeFileSync(
      path.join(harness, 'arena.yaml'),
      [
        'arena: 1',
        'name: claims-trust',
        'files:',
        '  - AGENTS.md',
        'install:',
        '  command: echo arena-trust-probe > EXECUTED.txt',
        '',
      ].join('\n'),
    );

    try {
      const spec = JSON.parse(fs.readFileSync(QUICK_SPEC, 'utf8')) as {
        competitors: { a: { harness: { source: string; trusted?: boolean } } };
      };
      // The client asserts trust in the spec itself and passes no trust argument to the tool.
      spec.competitors.a.harness = { source: harness, trusted: true };

      const answer = await callTool(session.client, 'arena_start_battle', { spec, waitMs: 90_000 });
      expect(answer.isError).toBe(false);
      expect(answer.data.finished).toBe(true);
      expect(answer.data.status).toBe('failed');
      expect(answer.data.trusted).toBe(false);
      expect(answer.data.refusedHarnessCommands.join(' ')).toContain('EXECUTED.txt');
      expect(fs.existsSync(marker), 'a spec field must never execute a harness command').toBe(false);

      const record = await callTool(session.client, 'arena_get_battle', { id: answer.data.id });
      expect(record.data.record.spec.competitors.a.harness.trusted).toBe(false);
      expect(record.data.record.runs.a.harness.executedCommands).toEqual([]);
    } finally {
      removeDir(harness);
    }
  }, 120_000);
});
