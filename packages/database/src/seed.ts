import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArenaEvent } from '@harness-arena/protocol';
import { EVENT_LIMITS, battleRecordSchema, safeParseEvent } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import { agents } from './schema/index.js';
import { AGENT_CATALOG } from './derive.js';
import { insertEvents, upsertArtifact, upsertBattleFromRecord } from './queries.js';

/**
 * Seeding logic, kept separate from the CLI entry point (src/cli/seed.ts) so it can be tested
 * without spawning a process. Every write is an upsert: running it twice changes nothing.
 */

/** The agent catalog: the CLIs Arena can drive, including the deterministic fake used by demos. */
export async function seedAgents(db: ArenaDatabase): Promise<number> {
  const rows = Object.entries(AGENT_CATALOG).map(([id, entry]) => ({
    id,
    displayName: entry.displayName,
    vendor: entry.vendor,
    homepage: entry.homepage,
  }));
  for (const row of rows) {
    await db
      .insert(agents)
      .values(row)
      .onConflictDoUpdate({
        target: agents.id,
        set: { displayName: row.displayName, vendor: row.vendor, homepage: row.homepage },
      });
  }
  return rows.length;
}

/** Walk up from this file to the workspace root (the directory holding pnpm-workspace.yaml). */
export function findRepoRoot(start = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface DemoFiles {
  recordFile: string;
  eventsFile: string;
}

/** Where `pnpm demo` writes the example battle, relative to the repository root. */
export function demoFilesFor(root: string): DemoFiles {
  return {
    recordFile: path.join(root, 'examples', 'demo', 'battle.json'),
    eventsFile: path.join(root, 'examples', 'demo', 'events.ndjson'),
  };
}

export function demoFilesExist(files: DemoFiles): boolean {
  return existsSync(files.recordFile) && existsSync(files.eventsFile);
}

export function readEventsFile(file: string): { events: ArenaEvent[]; invalid: number } {
  const events: ArenaEvent[] = [];
  let invalid = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid++;
      continue;
    }
    const result = safeParseEvent(parsed);
    if (result.success) events.push(result.data);
    else invalid++;
  }
  return { events, invalid };
}

export interface SeedDemoResult {
  battleId: string;
  created: boolean;
  events: number;
  eventsStored: number;
  eventsInvalid: number;
  artifacts: number;
}

/**
 * Load the generated demo battle: the record becomes a public demo battle, its events are ingested
 * in protocol-sized batches, and the diff and final response of each side become artifacts.
 */
export async function seedDemoBattle(db: ArenaDatabase, files: DemoFiles): Promise<SeedDemoResult> {
  const record = battleRecordSchema.parse(JSON.parse(readFileSync(files.recordFile, 'utf8')));
  const battle = await upsertBattleFromRecord(db, { record, visibility: 'public', demo: true });

  const { events, invalid } = readEventsFile(files.eventsFile);
  let stored = 0;
  for (let i = 0; i < events.length; i += EVENT_LIMITS.maxBatchEvents) {
    const batch = events.slice(i, i + EVENT_LIMITS.maxBatchEvents);
    const result = await insertEvents(db, record.id, batch);
    stored += result.accepted;
  }

  let artifacts = 0;
  for (const side of ['a', 'b'] as const) {
    const run = record.runs[side];
    if (run.artifacts.diff) {
      await upsertArtifact(db, {
        battleId: record.id,
        side,
        kind: 'diff',
        content: run.artifacts.diff,
        contentType: 'text/x-diff',
      });
      artifacts++;
    }
    if (run.artifacts.finalResponse) {
      await upsertArtifact(db, {
        battleId: record.id,
        side,
        kind: 'final_response',
        content: run.artifacts.finalResponse,
        contentType: 'text/markdown',
      });
      artifacts++;
    }
  }

  return {
    battleId: record.id,
    created: battle.created,
    events: events.length,
    eventsStored: stored,
    eventsInvalid: invalid,
    artifacts,
  };
}
