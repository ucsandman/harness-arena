import { describe, expect, it } from 'vitest';
import {
  arenaEventSchema,
  battleRecordSchema,
  reportBundleSchema,
  METRIC_KEYS,
  type ArenaEvent,
} from '@harness-arena/protocol';
import { SAMPLE_BUNDLE, SAMPLE_EVENTS, SAMPLE_RECORD, SAMPLE_REPORT } from '../lib/sample-battle';

describe('sample battle record', () => {
  it('validates against battleRecordSchema', () => {
    const result = battleRecordSchema.safeParse(SAMPLE_RECORD);
    if (!result.success) {
      throw new Error(
        `record invalid: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it('is flagged as demo data and is not eligible for the verified pool', () => {
    expect(SAMPLE_RECORD.demo).toBe(true);
    expect(SAMPLE_RECORD.verification.eligible).toBe(false);
    expect(SAMPLE_RECORD.task.source.kind).toBe('demo');
  });

  it('carries a complete metric set for both sides', () => {
    for (const side of ['a', 'b'] as const) {
      const metrics = SAMPLE_RECORD.runs[side].metrics;
      for (const key of METRIC_KEYS) expect(metrics[key]).toBeDefined();
    }
  });

  it('keeps cost unavailable for side B instead of reporting zero', () => {
    const cost = SAMPLE_RECORD.runs.b.metrics.cost_usd;
    expect(cost.status).toBe('unavailable');
    expect(cost.value).toBeNull();
    expect(cost.note).toBeTruthy();
    expect(SAMPLE_RECORD.runs.a.metrics.cost_usd.status).toBe('observed');
  });

  it('has a verdict for side A with reasons and caveats, and four insights', () => {
    expect(SAMPLE_RECORD.verdict?.winner).toBe('a');
    expect(SAMPLE_RECORD.verdict?.method).toBe('deterministic');
    expect(SAMPLE_RECORD.verdict?.reasons.length).toBeGreaterThanOrEqual(3);
    expect(SAMPLE_RECORD.verdict?.caveats.length).toBeGreaterThanOrEqual(3);
    expect(SAMPLE_RECORD.verdict?.judge).toBeNull();
    expect(SAMPLE_RECORD.insights).toHaveLength(4);
  });

  it('includes an evaluation report and a two-file diff per side', () => {
    expect(SAMPLE_RECORD.evaluation?.results.length).toBeGreaterThan(0);
    expect(SAMPLE_RECORD.evaluation?.comparisons.length).toBeGreaterThan(0);
    for (const side of ['a', 'b'] as const) {
      const diff = SAMPLE_RECORD.runs[side].artifacts.diff ?? '';
      expect(diff.split('diff --git ').length - 1).toBe(2);
    }
  });
});

describe('sample battle events', () => {
  it('validates every event against arenaEventSchema', () => {
    const failures: string[] = [];
    for (const event of SAMPLE_EVENTS) {
      const result = arenaEventSchema.safeParse(event);
      if (!result.success) {
        failures.push(
          `${event.type} (#${event.seq}): ${result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join(', ')}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('has roughly 120 events across both sides inside a five minute window', () => {
    expect(SAMPLE_EVENTS.length).toBeGreaterThanOrEqual(100);
    expect(SAMPLE_EVENTS.length).toBeLessThanOrEqual(140);
    const maxOffset = Math.max(...SAMPLE_EVENTS.map((event) => event.tOffsetMs));
    expect(maxOffset).toBeGreaterThan(240_000);
    expect(maxOffset).toBeLessThanOrEqual(330_000);
  });

  it('is ordered by sequence and by time, with unique ids', () => {
    const ids = new Set(SAMPLE_EVENTS.map((event) => event.id));
    expect(ids.size).toBe(SAMPLE_EVENTS.length);
    SAMPLE_EVENTS.forEach((event, index) => {
      expect(event.seq).toBe(index);
      if (index > 0) expect(event.tOffsetMs).toBeGreaterThanOrEqual(SAMPLE_EVENTS[index - 1]!.tOffsetMs);
    });
  });

  it('references the battle and the right run on each side', () => {
    for (const event of SAMPLE_EVENTS) {
      expect(event.battleId).toBe(SAMPLE_RECORD.id);
      if (event.side === 'a') expect(event.runId).toBe(SAMPLE_RECORD.runs.a.id);
      if (event.side === 'b') expect(event.runId).toBe(SAMPLE_RECORD.runs.b.id);
      if (event.side === null) expect(event.runId).toBeNull();
    }
  });

  it('covers both sides and the battle level', () => {
    const sides = new Set<ArenaEvent['side']>(SAMPLE_EVENTS.map((event) => event.side));
    expect(sides).toEqual(new Set(['a', 'b', null]));
  });

  it('matches the event counts recorded on each run', () => {
    expect(SAMPLE_RECORD.runs.a.eventCount).toBe(SAMPLE_EVENTS.filter((event) => event.side === 'a').length);
    expect(SAMPLE_RECORD.runs.b.eventCount).toBe(SAMPLE_EVENTS.filter((event) => event.side === 'b').length);
  });
});

describe('sample report bundle', () => {
  it('validates against reportBundleSchema', () => {
    expect(reportBundleSchema.safeParse(SAMPLE_BUNDLE).success).toBe(true);
    expect(SAMPLE_REPORT.record.id).toBe(SAMPLE_BUNDLE.record.id);
    expect(SAMPLE_REPORT.events).toHaveLength(SAMPLE_EVENTS.length);
  });
});
