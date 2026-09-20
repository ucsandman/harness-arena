import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BattleRecord } from '@harness-arena/protocol';
import { battleRecordSchema, fingerprintInput, isIntegrityTestPath } from '@harness-arena/protocol';
import { checkIntegrity, integrityFingerprint, isTestPath } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoFile = path.resolve(here, '../../../examples/demo/battle.json');

function demoRecord(overrides: Partial<BattleRecord> = {}): BattleRecord {
  const raw = JSON.parse(fs.readFileSync(demoFile, 'utf8')) as unknown;
  return battleRecordSchema.parse({ ...(battleRecordSchema.parse(raw) as object), ...overrides });
}

describe('integrityFingerprint', () => {
  it('is the sha256 of the canonical matchup string, or null without a repository commit', () => {
    const record = demoRecord();
    const input = fingerprintInput(record) as string;
    expect(input).toBeTypeOf('string');
    expect(integrityFingerprint(record)).toBe(createHash('sha256').update(input).digest('hex'));
    expect(integrityFingerprint(record)).toMatch(/^[0-9a-f]{64}$/);

    const unpinned = demoRecord({ repository: { ...record.repository, commit: null } });
    expect(integrityFingerprint(unpinned)).toBeNull();
  });

  it('is stable across reads of the same record and moves with the matchup', () => {
    expect(integrityFingerprint(demoRecord())).toBe(integrityFingerprint(demoRecord()));
    const record = demoRecord();
    const otherCommit = demoRecord({ repository: { ...record.repository, commit: 'deadbeef' } });
    expect(integrityFingerprint(otherCommit)).not.toBe(integrityFingerprint(record));
  });
});

describe('checkIntegrity', () => {
  it('blocks the demo battle and says why, echoing the version that checked it', () => {
    const report = checkIntegrity(demoRecord(), { checkedWith: 'arena/0.1.0-test' });
    expect(report.eligible).toBe(false);
    expect(report.checkedWith).toBe('arena/0.1.0-test');
    expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.flags.map((flag) => flag.code)).toContain('demo');
  });

  it('still blocks the demo battle when the demo flag is removed: its github harness has no commit', () => {
    // This is why apps/web tests may not use the exported demo battle as a stand-in for a rateable
    // result. `arena demo` never fetches a harness (packages/core/src/demo.ts), so run A carries
    // kind 'github' with commit null, which is exactly what the harness_commit_missing gate is for.
    const report = checkIntegrity(demoRecord({ demo: false }), { checkedWith: 'arena/0.1.0-test' });
    const blocking = report.flags.filter((flag) => flag.severity === 'block').map((flag) => flag.code);
    expect(blocking).toEqual(['harness_commit_missing']);
    expect(report.eligible).toBe(false);
  });

  it('rates a demo battle that was given a harness commit, with warnings kept', () => {
    const record = demoRecord({ demo: false });
    const pinned = demoRecord({
      demo: false,
      runs: {
        a: { ...record.runs.a, harness: { ...record.runs.a.harness, commit: 'c0ffee1' } },
        b: record.runs.b,
      },
    });
    const report = checkIntegrity(pinned, { checkedWith: 'arena/0.1.0-test' });
    expect(report.eligible).toBe(true);
    // upload: none and side B's edit to test/session.test.js are warnings, and both survive
    expect(report.flags.map((flag) => flag.code)).toEqual(['tests_modified', 'no_uploaded_evidence']);
    expect(report.flags.every((flag) => flag.severity === 'warn')).toBe(true);
  });

  it("passes the caller's duplicate through as a block", () => {
    const record = demoRecord({ demo: false });
    const report = checkIntegrity(record, { checkedWith: 'x', duplicateOf: 'btl_0000000000000009' });
    expect(report.flags.map((flag) => flag.code)).toContain('duplicate_battle');
    expect(report.eligible).toBe(false);
  });
});

describe('test-path agreement with the diff-signals evaluator', () => {
  it('the protocol copy of the regex matches the evaluator original on every shape', () => {
    const paths = [
      'test/session.test.js',
      'tests/unit/session.js',
      'src/__tests__/session.ts',
      'packages/app/src/session.spec.ts',
      'spec/models/user_spec.rb',
      'src\\auth\\session.test.ts',
      './test/a.js',
      'src/index.ts',
      'README.md',
      'src/protest/manifest.json',
      'lib/latest/build.js',
      'contest.ts',
    ];
    for (const p of paths) {
      expect({ p, protocol: isIntegrityTestPath(p) }).toEqual({ p, protocol: isTestPath(p) });
    }
  });
});
