import type { ArenaEvent, BattleRecord } from '@harness-arena/protocol';
import { getBattle, listBattles } from '@harness-arena/database';
import { loadEvents } from './battles';
import { db } from './db';
import { SAMPLE_REPORT } from './sample-battle';

/**
 * The battle shown on the landing page. Preferred source is the seeded demo battle in the database
 * (`pnpm db:seed` loads examples/demo), so the marketing page renders the same data path as a real
 * report; the hand-written bundle in lib/sample-battle.ts is the fallback when nothing is seeded.
 * Both are deterministic demo data and both are labelled as such.
 */

export const LANDING_EVENT_CAP = 800;

export interface LandingBattle {
  record: BattleRecord;
  events: ArenaEvent[];
  source: 'database' | 'bundled';
}

export async function loadLandingBattle(): Promise<LandingBattle> {
  try {
    const dbh = await db();
    const feed = await listBattles(dbh, { limit: 50 });
    const demo = feed.items.find((item) => item.demo);
    if (demo) {
      const found = await getBattle(dbh, demo.id);
      if (found) {
        const loaded = await loadEvents(dbh, demo.id, { cap: LANDING_EVENT_CAP });
        return { record: found.battle.record, events: loaded.events, source: 'database' };
      }
    }
  } catch {
    // no database configured or reachable: the bundled sample keeps the landing page honest and up
  }
  return { record: SAMPLE_REPORT.record, events: SAMPLE_REPORT.events, source: 'bundled' };
}
