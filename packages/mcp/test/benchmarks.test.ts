import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/server.js';
import { callTool, connect, removeDir, REPO_ROOT, tempDir, type Connected } from './helpers.js';

/**
 * Benchmark packs and experiments through the MCP tools: listing the bundled arena-smoke pack, running
 * one of its tasks as a battle (fake agent, vanilla harness: no network, no model spend), and the local
 * experiment record round trip.
 */

const SMOKE_PACK = path.join(REPO_ROOT, 'examples', 'benchmarks', 'arena-smoke', 'pack.yaml');

let home: string;
let session: Connected;

beforeAll(async () => {
  home = tempDir('benchmarks');
  session = await connect({ home, deps: { exampleHarnessDir: null } });
});

afterAll(async () => {
  await session.close();
  removeDir(home);
});

describe('the new tool names', () => {
  it('appear in the server tool list', async () => {
    const listed = await session.client.listTools();
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain('arena_list_benchmarks');
    expect(names).toContain('arena_run_benchmark');
    expect(names).toContain('arena_run_experiment');
    expect(names).toContain('arena_compare_versions');
    expect(names).toContain('arena_get_experiment');
    for (const name of [
      'arena_list_benchmarks',
      'arena_run_benchmark',
      'arena_run_experiment',
      'arena_compare_versions',
      'arena_get_experiment',
    ]) {
      expect(TOOL_NAMES as readonly string[]).toContain(name);
    }
  });
});

describe('arena_list_benchmarks', () => {
  it('finds the arena-smoke pack with its 3 tasks and a versionId', async () => {
    const answer = await callTool(session.client, 'arena_list_benchmarks');
    expect(answer.isError).toBe(false);
    const smoke = answer.data.packs.find((p: { slug: string }) => p.slug === 'arena-smoke');
    expect(smoke).toBeDefined();
    expect(smoke.taskCount).toBe(3);
    expect(smoke.tasks).toHaveLength(3);
    expect(smoke.versionId).toMatch(/^bmv_[0-9a-f]{24}$/);
    expect(answer.data.problems).toEqual([]);
  });
});

describe('arena_run_benchmark', () => {
  it('runs one task as a single completed battle with the fake agent and vanilla harnesses', async () => {
    const answer = await callTool(session.client, 'arena_run_benchmark', {
      slug: 'arena-smoke',
      taskId: 'debugging-notes',
      agent: 'fake',
      a: 'vanilla',
      b: 'vanilla',
    });
    expect(answer.isError).toBe(false);
    expect(answer.data.slug).toBe('arena-smoke');
    expect(answer.data.battles).toHaveLength(1);
    expect(answer.data.battles[0].taskId).toBe('debugging-notes');
    expect(answer.data.battles[0].status).toBe('completed');
    expect(answer.data.completed).toBe(1);
    expect(answer.data.failed).toBe(0);
  }, 120_000);
});

describe('arena_get_experiment and arena_run_experiment', () => {
  it('errors on an unknown id', async () => {
    const answer = await callTool(session.client, 'arena_get_experiment', { id: 'exp_doesnotexist0' });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('exp_doesnotexist0');
  });

  it('runs a single-task experiment and reads the saved record back', async () => {
    const ran = await callTool(session.client, 'arena_run_experiment', {
      kind: 'comparison',
      control: 'vanilla',
      treatment: 'vanilla',
      benchmark: SMOKE_PACK,
      taskId: 'debugging-notes',
      agent: 'fake',
    });
    expect(ran.isError).toBe(false);
    expect(ran.data.battles).toHaveLength(1);
    expect(ran.data.record.summary).toBeNull();
    expect(ran.data.record.status).toBe('completed');
    expect(ran.data.summaryNote).toContain('arena experiment show');

    const id = ran.data.id as string;
    const fetched = await callTool(session.client, 'arena_get_experiment', { id });
    expect(fetched.isError).toBe(false);
    expect(fetched.data.record.id).toBe(id);
    expect(fetched.data.record.battles).toHaveLength(1);
  }, 120_000);
});
