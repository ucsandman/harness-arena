import { createHash } from 'node:crypto';
import type { BattleRecord, IntegrityReport } from '@harness-arena/protocol';
import { buildIntegrityReport, computeIntegrityFlags, fingerprintInput } from '@harness-arena/protocol';

/**
 * Server-side integrity: the same checks the evaluator runs, recomputed here on every upload.
 *
 * The database package cannot depend on the evaluator (the evaluator spawns processes and the web app
 * imports the database from a server component), so the sha256 wrapper is duplicated rather than
 * imported. The checks themselves are not duplicated: they live in the protocol, and
 * `packages/database/test/battles.test.ts` pins that this module and `checkIntegrity` in the
 * evaluator produce the same report for the same record.
 *
 * A client's `record.integrity` is never trusted: `upsertBattleFromRecord` overwrites it with this.
 */

/** sha256 of the canonical matchup string; null when the record has no repository commit to pin. */
export function battleFingerprint(record: BattleRecord): string | null {
  const input = fingerprintInput(record);
  return input === null ? null : createHash('sha256').update(input).digest('hex');
}

export function computeBattleIntegrity(
  record: BattleRecord,
  opts: { duplicateOf?: string | null; checkedWith?: string } = {},
): IntegrityReport {
  const flags = computeIntegrityFlags(record, { duplicateOf: opts.duplicateOf ?? null });
  return buildIntegrityReport(flags, battleFingerprint(record), opts.checkedWith ?? record.arenaVersion);
}

/**
 * A battle may move a rating only when nothing blocked it AND the battle finished: a running battle's
 * verdict can still change, and a rating change is never taken back.
 */
export function ratingEligibleFor(record: BattleRecord, integrity: IntegrityReport): boolean {
  return integrity.eligible && record.status === 'completed';
}
