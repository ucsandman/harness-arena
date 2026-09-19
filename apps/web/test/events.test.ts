import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '@harness-arena/protocol';
import {
  EVENT_CATEGORIES,
  categoryLabel,
  categoryOf,
  countByCategory,
  eventSummary,
  eventsForSide,
  groupByCategory,
  isProblem,
  matchesQuery,
} from '../lib/events';
import { SAMPLE_EVENTS } from '../lib/sample-battle';

describe('event categories', () => {
  it('covers every protocol event type exactly once', () => {
    const mapped = EVENT_CATEGORIES.flatMap((category) => category.types);
    expect(new Set(mapped).size).toBe(mapped.length);
    expect([...mapped].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('maps types to their category', () => {
    expect(categoryOf('tool.called')).toBe('tools');
    expect(categoryOf('model.response')).toBe('model');
    expect(categoryOf('test.completed')).toBe('tests');
    expect(categoryOf('error')).toBe('problems');
    expect(categoryOf('file.changed')).toBe('files');
    expect(categoryOf('command.started')).toBe('commands');
    expect(categoryOf('subagent.spawned')).toBe('subagents');
    expect(categoryOf('battle.started')).toBe('lifecycle');
  });

  it('falls back to lifecycle for an unknown type', () => {
    expect(categoryOf('something.new')).toBe('lifecycle');
    expect(categoryLabel('problems')).toBe('Problems');
  });
});

describe('grouping the sample battle', () => {
  it('counts every event into exactly one category', () => {
    const counts = countByCategory(SAMPLE_EVENTS);
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(SAMPLE_EVENTS.length);
    expect(counts.problems).toBeGreaterThan(0);
    expect(counts.tools).toBeGreaterThan(0);
  });

  it('groups without losing or duplicating events', () => {
    const grouped = groupByCategory(SAMPLE_EVENTS);
    const total = Object.values(grouped).reduce((sum, list) => sum + list.length, 0);
    expect(total).toBe(SAMPLE_EVENTS.length);
  });

  it('splits by side', () => {
    const a = eventsForSide(SAMPLE_EVENTS, 'a');
    const b = eventsForSide(SAMPLE_EVENTS, 'b');
    expect(a.length).toBeGreaterThan(20);
    expect(b.length).toBeGreaterThan(20);
    expect(a.every((event) => event.side === 'a')).toBe(true);
    expect(b.every((event) => event.side === 'b')).toBe(true);
  });

  it('flags problem events', () => {
    const problems = SAMPLE_EVENTS.filter(isProblem);
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.every((event) => ['warning', 'error', 'limit.hit', 'context.compacted'].includes(event.type)),
    ).toBe(true);
  });
});

describe('eventSummary', () => {
  it('produces a one-line summary for every event in the sample', () => {
    for (const event of SAMPLE_EVENTS) {
      const summary = eventSummary(event);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).not.toContain('\n');
      expect(summary.length).toBeLessThanOrEqual(160);
    }
  });

  it('strips ANSI from agent output', () => {
    const output = SAMPLE_EVENTS.find((event) => event.type === 'agent.output');
    expect(output).toBeDefined();
    expect(eventSummary(output!)).not.toContain('\u001B');
  });
});

describe('matchesQuery', () => {
  const first = SAMPLE_EVENTS[0]!;

  it('matches on type, native source and summary', () => {
    expect(matchesQuery(first, '')).toBe(true);
    expect(matchesQuery(first, 'battle')).toBe(true);
    expect(matchesQuery(first, 'zzzz-not-present')).toBe(false);
  });
});
