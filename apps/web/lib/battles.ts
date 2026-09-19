import { EVENT_LIMITS, safeParseEvent, type ArenaEvent, type BattleRecord } from '@harness-arena/protocol';
import {
  getBattle,
  listEvents,
  type ArenaDatabase,
  type Battle,
  type EventRow,
} from '@harness-arena/database';

/**
 * Reading a battle's event log out of the database. `listEvents` is capped at one protocol batch, so
 * anything that needs the whole log (a report page, a JSON download) pages through it here.
 */

export type OwnedBattle = { ok: true; battle: Battle } | { ok: false; code: 'not_found' | 'forbidden' };

/**
 * Ownership gate for every mutation. A battle with no owner (the seeded demo, or a record uploaded
 * before accounts existed) belongs to nobody and can never be written through the API.
 */
export async function ownedBattle(db: ArenaDatabase, id: string, userId: string): Promise<OwnedBattle> {
  const found = await getBattle(db, id);
  if (!found) return { ok: false, code: 'not_found' };
  if (found.battle.ownerUserId !== userId) return { ok: false, code: 'forbidden' };
  return { ok: true, battle: found.battle };
}

/**
 * A record that arrived with a device token was executed on the uploader's own machine, whatever it
 * claims about itself. The server decides the provenance, never the payload: verification is clamped
 * to self-reported here, at the untrusted-input boundary, so an upload can never enter the verified
 * ratings pool (which stays empty until Arena executes battles itself).
 */
export function clampSelfReported(record: BattleRecord): BattleRecord {
  const verification = record.verification;
  if (verification.kind === 'local' && !verification.eligible && verification.sandbox === null) {
    return record;
  }
  return { ...record, verification: { kind: 'local', eligible: false, sandbox: null } };
}

/** Hard cap for one page render or one API response. Anything beyond it is reported, never hidden. */
export const MAX_PAGE_EVENTS = 5000;

const PAGE_SIZE = EVENT_LIMITS.maxBatchEvents;

/** A stored row back into a protocol event. Returns null when the row does not validate. */
export function eventRowToEvent(row: EventRow): ArenaEvent | null {
  const parsed = safeParseEvent({
    v: 1,
    id: row.id,
    battleId: row.battleId,
    runId: row.runId,
    side: row.side,
    seq: row.seq,
    ts: row.ts.toISOString(),
    tOffsetMs: row.tOffsetMs,
    source: row.source,
    confidence: row.confidence,
    type: row.type,
    payload: row.payload,
  });
  return parsed.success ? parsed.data : null;
}

export interface LoadedEvents {
  events: ArenaEvent[];
  /** rows that failed protocol validation (never rendered, always counted) */
  invalid: number;
  /** true when the cap stopped the read before the end of the log */
  capped: boolean;
  lastSeq: number | null;
}

export async function loadEvents(
  db: ArenaDatabase,
  battleId: string,
  opts: { afterSeq?: number; cap?: number } = {},
): Promise<LoadedEvents> {
  const cap = Math.max(1, Math.min(opts.cap ?? MAX_PAGE_EVENTS, MAX_PAGE_EVENTS));
  const events: ArenaEvent[] = [];
  let invalid = 0;
  let afterSeq = opts.afterSeq;
  let capped = false;
  let lastSeq: number | null = null;

  for (;;) {
    const rows = await listEvents(db, battleId, {
      limit: PAGE_SIZE,
      ...(afterSeq === undefined ? {} : { afterSeq }),
    });
    for (const row of rows) {
      lastSeq = row.seq;
      if (events.length >= cap) {
        capped = true;
        break;
      }
      const event = eventRowToEvent(row);
      if (event) events.push(event);
      else invalid++;
    }
    if (capped || rows.length < PAGE_SIZE) break;
    const last = rows[rows.length - 1];
    if (!last) break;
    afterSeq = last.seq;
  }

  return { events, invalid, capped, lastSeq };
}
