import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ID_PREFIX,
  arenaEventSchema,
  battleSpecSchema,
  emptyMetrics,
  eventPayloads,
  EVENT_TYPES,
  harnessManifestSchema,
  isId,
  makeId,
  METRIC_KEYS,
  observed,
  parseEvent,
  runMetricsSchema,
  unavailable,
  validateManifest,
  METRIC_DIRECTION,
  METRIC_LABELS,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, '../../../examples/battles');

describe('ids', () => {
  it('makes prefixed ids that validate', () => {
    for (const kind of Object.keys(ID_PREFIX) as (keyof typeof ID_PREFIX)[]) {
      const id = makeId(kind);
      expect(id.startsWith(`${ID_PREFIX[kind]}_`)).toBe(true);
      expect(id).toHaveLength(ID_PREFIX[kind].length + 1 + 16);
      expect(isId(kind, id)).toBe(true);
      expect(isId(kind, 'nope')).toBe(false);
    }
  });
  it('is unique across many draws', () => {
    const set = new Set(Array.from({ length: 2000 }, () => makeId('event')));
    expect(set.size).toBe(2000);
  });
});

describe('events', () => {
  const base = {
    v: 1 as const,
    id: makeId('event'),
    battleId: makeId('battle'),
    runId: makeId('run'),
    side: 'a' as const,
    seq: 1,
    ts: new Date().toISOString(),
    tOffsetMs: 10,
    source: { adapter: 'claude-code', native: 'assistant.tool_use' },
    confidence: 'observed' as const,
  };

  it('accepts a valid tool.called event', () => {
    const e = parseEvent({ ...base, type: 'tool.called', payload: { toolId: 't1', name: 'Read' } });
    expect(e.type).toBe('tool.called');
  });

  it('rejects unknown types and mismatched payloads', () => {
    expect(arenaEventSchema.safeParse({ ...base, type: 'nope', payload: {} }).success).toBe(false);
    expect(arenaEventSchema.safeParse({ ...base, type: 'tool.called', payload: {} }).success).toBe(false);
    expect(
      arenaEventSchema.safeParse({ ...base, v: 2, type: 'warning', payload: { message: 'x' } }).success,
    ).toBe(false);
  });

  it('has a payload schema for every event type in the union', () => {
    expect(EVENT_TYPES.length).toBe(Object.keys(eventPayloads).length);
    expect(arenaEventSchema.options.length).toBe(EVENT_TYPES.length);
  });
});

describe('metrics', () => {
  it('emptyMetrics covers every key as unavailable', () => {
    const m = emptyMetrics();
    for (const k of METRIC_KEYS) {
      expect(m[k]).toEqual(unavailable());
      expect(METRIC_LABELS[k]).toBeTruthy();
      expect(METRIC_DIRECTION[k]).toBeTruthy();
    }
    expect(runMetricsSchema.safeParse(m).success).toBe(true);
  });
  it('observed values validate', () => {
    const m = { ...emptyMetrics(), tokens_total: observed(1234, 'test') };
    expect(runMetricsSchema.parse(m).tokens_total.value).toBe(1234);
  });
});

describe('battle spec', () => {
  it('applies defaults', () => {
    const spec = battleSpecSchema.parse({
      version: 1,
      task: { kind: 'prompt', prompt: 'do it' },
      repository: { source: 'empty' },
      competitors: {
        a: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
        b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
      },
    });
    expect(spec.limits.timeoutMs).toBe(20 * 60_000);
    expect(spec.privacy.upload).toBe('none');
    expect(spec.evaluation.assertions).toEqual([]);
    expect(spec.evaluation.judge.enabled).toBe(false);
    expect(spec.visibility).toBe('private');
    expect(spec.mode).toBe('local');
  });

  it('validates the shipped example specs', () => {
    for (const f of ['fake-quick.json', 'claude-code-issue.json']) {
      const raw = JSON.parse(fs.readFileSync(path.join(examples, f), 'utf8'));
      const r = battleSpecSchema.safeParse(raw);
      expect(r.success, `${f}: ${JSON.stringify(r.success ? null : r.error.issues)}`).toBe(true);
    }
  });

  it('rejects bad agent ids and oversized prompts', () => {
    const bad = battleSpecSchema.safeParse({
      version: 1,
      task: { kind: 'prompt', prompt: 'x'.repeat(60_000) },
      repository: { source: 'empty' },
      competitors: {
        a: { agent: { id: 'Claude Code' }, harness: { source: 'vanilla' } },
        b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
      },
    });
    expect(bad.success).toBe(false);
  });
});

describe('manifest', () => {
  it('accepts a minimal manifest and rejects unknown keys', () => {
    expect(validateManifest({ arena: 1, name: 'x' }).ok).toBe(true);
    const r = validateManifest({ arena: 1, name: 'x', installs: { command: 'rm -rf /' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/installs|Unrecognized/i);
  });
  it('rejects bad names and wrong versions', () => {
    expect(harnessManifestSchema.safeParse({ arena: 2, name: 'x' }).success).toBe(false);
    expect(harnessManifestSchema.safeParse({ arena: 1, name: 'Bad Name' }).success).toBe(false);
  });
  it('accepts per-agent config', () => {
    const r = validateManifest({
      arena: 1,
      name: 'h',
      agentConfig: { 'claude-code': { args: ['--effort', 'high'], env: { MY_VAR: '${ARENA_WORKSPACE}' } } },
    });
    expect(r.ok).toBe(true);
  });
});
