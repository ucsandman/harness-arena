import { describe, expect, it } from 'vitest';
import { battleSpecSchema, calculated, emptyMetrics, observed, unavailable } from '@harness-arena/protocol';
import type { ArenaEvent, BattleRecord, RunMetrics, Side } from '@harness-arena/protocol';
import { computeInsights, humanDuration, humanRatio } from '../src/insights.js';
import { makeEvent, makeRecord } from './helpers.js';

const SPEC = battleSpecSchema.parse({
  version: 1,
  task: { kind: 'prompt', prompt: 'Fix the session-expiry bug.' },
  repository: { source: 'empty' },
  competitors: {
    a: { label: 'Agnostic AI', agent: { id: 'fake' }, harness: { source: 'vanilla' } },
    b: { label: 'Vanilla Claude Code', agent: { id: 'fake' }, harness: { source: 'vanilla' } },
  },
});

function metricsFor(side: Side): RunMetrics {
  const m = emptyMetrics();
  if (side === 'a') {
    m.duration_ms = calculated(10_000, 'core:clock');
    m.files_inspected = calculated(12, 'core:events');
    m.retries = calculated(0, 'core:events');
    m.subagents_spawned = calculated(1, 'core:events');
    m.turns = observed(10, 'fake:turns');
    m.tokens_total = observed(6600, 'fake:usage');
    m.cost_usd = observed(0.4, 'fake:usage');
    m.regressions = calculated(0, 'core:tests');
  } else {
    m.duration_ms = calculated(20_000, 'core:clock');
    m.files_inspected = calculated(31, 'core:events');
    m.retries = calculated(2, 'core:events');
    m.subagents_spawned = calculated(0, 'core:events');
    m.turns = observed(4, 'fake:turns');
    m.tokens_total = observed(10_000, 'fake:usage');
    m.cost_usd = unavailable('cost is not reported by fake');
    m.regressions = calculated(1, 'core:tests');
  }
  return m;
}

const EVENTS: ArenaEvent[] = [
  // sequential runs: side B starts 20 s after side A, so absolute offsets must not be compared directly
  makeEvent(
    'run.started',
    { side: 'a', agent: 'fake', harness: 'vanilla' },
    { seq: 1, side: 'a', tOffsetMs: 0 },
  ),
  makeEvent(
    'run.started',
    { side: 'b', agent: 'fake', harness: 'vanilla' },
    { seq: 15, side: 'b', tOffsetMs: 20_000 },
  ),
  makeEvent(
    'test.completed',
    {
      command: 'node --test',
      phase: 'post',
      exitCode: 1,
      passed: 2,
      failed: 1,
      total: 3,
      durationMs: 5,
      parser: 'tap',
    },
    { seq: 10, side: 'a', tOffsetMs: 3000 },
  ),
  makeEvent(
    'test.completed',
    {
      command: 'node --test',
      phase: 'post',
      exitCode: 1,
      passed: 2,
      failed: 1,
      total: 3,
      durationMs: 5,
      parser: 'tap',
    },
    { seq: 20, side: 'b', tOffsetMs: 60_000 },
  ),
  makeEvent(
    'subagent.spawned',
    { subagentId: 's1', name: 'test-runner' },
    { seq: 11, side: 'a', tOffsetMs: 1200 },
  ),
];

function record(): BattleRecord {
  return makeRecord({
    spec: SPEC,
    a: { label: 'Agnostic AI', metrics: metricsFor('a') },
    b: { label: 'Vanilla Claude Code', metrics: metricsFor('b') },
  });
}

describe('computeInsights', () => {
  const insights = computeInsights(record(), EVENTS);
  const text = insights.map((i) => i.text);
  const byId = new Map(insights.map((i) => [i.id, i]));

  it('reports which side saw the failing test first, with the real gap', () => {
    expect(text).toContain('Agnostic AI found the failing test 37 seconds earlier.');
    expect(byId.get('first-failing-test')?.favors).toBe('a');
    expect(byId.get('first-failing-test')?.support.eventSeqs).toEqual([10, 20]);
  });

  it('reports the files-inspected difference', () => {
    expect(text).toContain('Agnostic AI inspected fewer files (12 vs 31).');
    expect(byId.get('files-inspected')?.support.metrics).toEqual(['files_inspected']);
  });

  it('reports retries', () => {
    expect(text).toContain('Vanilla Claude Code required 2 retries before the suite passed.');
    expect(byId.get('retries-b')?.favors).toBe('a');
  });

  it('reports subagent use and links the events that prove it', () => {
    expect(text).toContain(
      'Agnostic AI spawned a specialist subagent; Vanilla Claude Code worked in a single agent.',
    );
    expect(byId.get('subagents-a')?.support.eventSeqs).toEqual([11]);
  });

  it('reports faster-but-more-interactions without picking a winner', () => {
    expect(text).toContain('Agnostic AI finished 2x faster but used more agent turns (10 vs 4).');
    expect(byId.get('faster-more-turns')?.favors).toBe('none');
  });

  it('reports the token difference as a percentage when both sides observed it', () => {
    expect(text).toContain('Agnostic AI used 34% fewer tokens (6,600 vs 10,000).');
  });

  it('warns about regressions', () => {
    expect(text).toContain('Vanilla Claude Code broke 1 test that passed before the change.');
    expect(byId.get('regressions-b')?.kind).toBe('warning');
  });

  it('warns that a metric could not be compared instead of showing zero', () => {
    expect(text).toContain('Cost is not reported by fake, so it is shown as n/a rather than zero.');
    expect(byId.has('cheaper-cost_usd')).toBe(false);
  });

  it('derives nothing when there is no comparable telemetry', () => {
    const blank = makeRecord({ spec: SPEC });
    const insightsOfBlank = computeInsights(blank, []);
    expect(insightsOfBlank.map((i) => i.id)).toEqual(['unavailable-cost_usd', 'unavailable-tokens_total']);
  });

  it('every insight names its support', () => {
    for (const insight of insights) {
      expect(insight.support.metrics.length + insight.support.eventSeqs.length).toBeGreaterThan(0);
    }
  });
});

describe('number formatting', () => {
  it('formats durations for humans', () => {
    expect(humanDuration(37_000)).toBe('37 seconds');
    expect(humanDuration(450)).toBe('450 ms');
    expect(humanDuration(150_000)).toBe('2.5 minutes');
    expect(humanDuration(7_200_000)).toBe('2 hours');
  });

  it('formats ratios', () => {
    expect(humanRatio(2.14)).toBe('2.1x');
    expect(humanRatio(2)).toBe('2x');
  });
});
