import { describe, expect, it } from 'vitest';
import { METRIC_KEYS } from '@harness-arena/protocol';
import type { ArenaEvent } from '@harness-arena/protocol';
import type { AdapterResult } from '@harness-arena/adapters';
import { aggregateRunMetrics } from '../src/metrics.js';
import type { DiffStats } from '../src/git.js';
import { FULL_CAPABILITIES, makeEvent, makeTestOutcome } from './helpers.js';

const RESULT: AdapterResult = {
  status: 'completed',
  exitCode: 0,
  finalResponse: 'done',
  usage: {
    inputTokens: 900,
    outputTokens: 100,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    totalTokens: 1015,
    costUsd: 0.12,
  },
  model: 'fake-model-1',
  version: '9.9.9',
  turns: 4,
  errorCode: null,
  errorMessage: null,
  native: {},
};

const DIFF: DiffStats = {
  files: [
    { path: 'src/a.js', kind: 'modify', linesAdded: 4, linesRemoved: 2, binary: false },
    { path: 'src/b.js', kind: 'create', linesAdded: 10, linesRemoved: 0, binary: false },
    { path: 'logo.png', kind: 'create', linesAdded: 0, linesRemoved: 0, binary: true },
  ],
  diff: 'diff --git a/src/a.js b/src/a.js',
  diffBytes: 33,
  truncated: false,
};

function events(): ArenaEvent[] {
  return [
    makeEvent('model.request', { model: 'm' }, { seq: 1 }),
    makeEvent('model.request', { model: 'm' }, { seq: 2 }),
    makeEvent('tool.called', { toolId: 't1', name: 'Read' }, { seq: 3 }),
    makeEvent('tool.called', { toolId: 't2', name: 'Bash' }, { seq: 4 }),
    makeEvent('command.started', { commandId: 'c1', command: 'npm test' }, { seq: 5 }),
    makeEvent('file.read', { path: 'src/a.js' }, { seq: 6 }),
    makeEvent('file.read', { path: 'src/a.js' }, { seq: 7 }),
    makeEvent('file.read', { path: 'src/b.js' }, { seq: 8 }),
    makeEvent('subagent.spawned', { subagentId: 's1', name: 'test-runner' }, { seq: 9 }),
    makeEvent('context.compacted', { trigger: 'auto' }, { seq: 10 }),
    makeEvent('error', { code: 'tool_error', message: 'boom', fatal: false }, { seq: 11 }),
    makeEvent('human.intervention', { kind: 'permission' }, { seq: 12 }),
    makeEvent('warning', { code: 'retry_after_failure', message: 'retrying' }, { seq: 13 }),
    makeEvent(
      'test.completed',
      {
        command: 'node --test',
        phase: 'post',
        exitCode: 1,
        passed: 2,
        failed: 1,
        total: 3,
        durationMs: 10,
        parser: 'tap',
      },
      { seq: 14 },
    ),
    makeEvent(
      'test.completed',
      {
        command: 'node --test',
        phase: 'post',
        exitCode: 0,
        passed: 3,
        failed: 0,
        total: 3,
        durationMs: 10,
        parser: 'tap',
      },
      { seq: 15 },
    ),
  ];
}

describe('aggregateRunMetrics', () => {
  const metrics = aggregateRunMetrics({
    events: events(),
    adapterResult: RESULT,
    capabilities: FULL_CAPABILITIES,
    diff: DIFF,
    tests: {
      baseline: makeTestOutcome({ passed: 2, failed: 1, total: 3, failingTests: ['session expires early'] }),
      post: makeTestOutcome({ passed: 2, failed: 1, total: 3, failingTests: ['another test'] }),
    },
    status: 'completed',
    exitCode: 0,
    durationMs: 4200,
    agentId: 'fake',
  });

  it('fills every metric key', () => {
    for (const key of METRIC_KEYS) expect(metrics[key]).toBeDefined();
    expect(Object.keys(metrics).sort()).toEqual([...METRIC_KEYS].sort());
  });

  it('marks CLI-reported values observed', () => {
    expect(metrics.tokens_input).toMatchObject({ value: 900, status: 'observed', source: 'fake:usage' });
    expect(metrics.tokens_total).toMatchObject({ value: 1015, status: 'observed' });
    expect(metrics.cost_usd).toMatchObject({ value: 0.12, status: 'observed', unit: 'usd' });
    expect(metrics.turns).toMatchObject({ value: 4, status: 'observed' });
    expect(metrics.exit_code).toMatchObject({ value: 0, status: 'observed' });
    expect(metrics.completion_status).toMatchObject({ value: 'completed', status: 'observed' });
  });

  it('marks Arena-derived values calculated', () => {
    expect(metrics.duration_ms).toMatchObject({ value: 4200, status: 'calculated' });
    expect(metrics.model_requests).toMatchObject({ value: 2, status: 'calculated' });
    expect(metrics.tool_calls).toMatchObject({ value: 2, status: 'calculated' });
    expect(metrics.commands_run).toMatchObject({ value: 1, status: 'calculated' });
    expect(metrics.files_inspected).toMatchObject({ value: 2, status: 'calculated' });
    expect(metrics.subagents_spawned).toMatchObject({ value: 1, status: 'calculated' });
    expect(metrics.context_compactions).toMatchObject({ value: 1, status: 'calculated' });
    expect(metrics.errors).toMatchObject({ value: 1, status: 'calculated' });
    expect(metrics.human_interventions).toMatchObject({ value: 1, status: 'calculated' });
  });

  it('counts a failing post-run test before a pass, plus retry warnings, as retries', () => {
    expect(metrics.retries).toMatchObject({ value: 2, status: 'calculated' });
  });

  it('takes the change size from git, not from the agent', () => {
    expect(metrics.files_changed).toMatchObject({ value: 3, status: 'calculated', source: 'core:git-diff' });
    expect(metrics.lines_added).toMatchObject({ value: 14, status: 'calculated' });
    expect(metrics.lines_removed).toMatchObject({ value: 2, status: 'calculated' });
  });

  it('counts a test that fails only after the change as a regression', () => {
    expect(metrics.regressions).toMatchObject({ value: 1, status: 'calculated' });
    expect(metrics.regressions.note).toContain('another test');
  });
});

describe('aggregateRunMetrics honesty', () => {
  it('reports unavailable, never zero, for telemetry the CLI cannot produce', () => {
    const metrics = aggregateRunMetrics({
      events: events(),
      adapterResult: { ...RESULT, usage: null, turns: null },
      capabilities: {
        ...FULL_CAPABILITIES,
        tokens: 'unavailable',
        cost: 'unavailable',
        turns: 'unavailable',
        subagents: 'unavailable',
        fileReads: 'unavailable',
      },
      diff: null,
      tests: { baseline: null, post: null },
      status: 'failed',
      exitCode: null,
      durationMs: 100,
      agentId: 'codex',
    });
    expect(metrics.cost_usd).toEqual({
      value: null,
      status: 'unavailable',
      note: 'cost is not reported by codex',
    });
    expect(metrics.tokens_total.value).toBeNull();
    expect(metrics.turns.value).toBeNull();
    expect(metrics.subagents_spawned.value).toBeNull();
    expect(metrics.files_inspected.value).toBeNull();
    expect(metrics.files_changed.value).toBeNull();
    expect(metrics.lines_added.value).toBeNull();
    expect(metrics.tests_total.value).toBeNull();
    expect(metrics.exit_code.value).toBeNull();
    expect(metrics.regressions.value).toBeNull();
    // Counts Arena itself derives stay available even for a blind CLI.
    expect(metrics.errors).toMatchObject({ value: 1, status: 'calculated' });
    expect(metrics.tool_calls).toMatchObject({ value: 2, status: 'calculated' });
  });

  it('says why regressions are unknown when there is no baseline', () => {
    const metrics = aggregateRunMetrics({
      events: [],
      adapterResult: RESULT,
      capabilities: FULL_CAPABILITIES,
      diff: DIFF,
      tests: { baseline: null, post: makeTestOutcome({ failed: 1, failingTests: ['x'] }) },
      status: 'completed',
      exitCode: 0,
      durationMs: 10,
      agentId: 'fake',
    });
    expect(metrics.regressions.status).toBe('unavailable');
    expect(metrics.regressions.note).toContain('no baseline');
  });

  it('falls back to calculated status when there is no adapter result at all', () => {
    const metrics = aggregateRunMetrics({
      events: [],
      adapterResult: null,
      capabilities: null,
      diff: null,
      tests: { baseline: null, post: null },
      status: 'interrupted',
      exitCode: null,
      durationMs: null,
      agentId: 'fake',
    });
    expect(metrics.completion_status).toMatchObject({ value: 'interrupted', status: 'calculated' });
    expect(metrics.duration_ms.value).toBeNull();
  });
});
