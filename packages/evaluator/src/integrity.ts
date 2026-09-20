import { createHash } from 'node:crypto';
import type { BattleRecord, IntegrityReport } from '@harness-arena/protocol';
import { buildIntegrityReport, computeIntegrityFlags, fingerprintInput } from '@harness-arena/protocol';

/**
 * Integrity checks: a pure function of a BattleRecord that decides rating eligibility and the
 * duplicate fingerprint.
 *
 * The checks themselves live in the protocol so a CLI, the server and a reviewer all reach the same
 * verdict from the same record. This module adds the one thing the protocol cannot do in a browser or
 * synchronously: the sha256 of the canonical matchup string. `duplicateOf` is the caller's job,
 * because only a database can know whether this fingerprint was already rated.
 */

/** sha256 of the canonical matchup string; null when the record has no repository commit to pin. */
export function integrityFingerprint(record: BattleRecord): string | null {
  const input = fingerprintInput(record);
  return input === null ? null : createHash('sha256').update(input).digest('hex');
}

export function checkIntegrity(
  record: BattleRecord,
  opts: { duplicateOf?: string | null; checkedWith: string },
): IntegrityReport {
  const flags = computeIntegrityFlags(record, { duplicateOf: opts.duplicateOf ?? null });
  return buildIntegrityReport(flags, integrityFingerprint(record), opts.checkedWith);
}
