import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../src/schema/index.js';
import type { ArenaDb } from '../src/client.js';
import {
  demoFilesExist,
  demoFilesFor,
  findRepoRoot,
  readEventsFile,
  seedAgents,
  seedDemoBattle,
} from '../src/seed.js';
import { countEvents, getBattle, getBattleForViewer, listArtifacts } from '../src/queries.js';
import { buildEvent, buildRecord, freshDb } from './helpers.js';

let handle: ArenaDb;
let dir: string;

beforeEach(async () => {
  handle = await freshDb();
  dir = await mkdtemp(path.join(os.tmpdir(), 'arena-seed-'));
});

afterEach(async () => {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
});

async function writeDemo(): Promise<{ recordFile: string; eventsFile: string; id: string }> {
  const record = buildRecord({
    visibility: 'private',
    diffA: 'diff --git a/src/index.ts b/src/index.ts\n+fixed\n',
    finalResponseA: 'Fixed the parser.',
  });
  const demoDir = path.join(dir, 'examples', 'demo');
  await mkdir(demoDir, { recursive: true });
  const recordFile = path.join(demoDir, 'battle.json');
  const eventsFile = path.join(demoDir, 'events.ndjson');
  const lines = [buildEvent(record.id, 0), buildEvent(record.id, 1, 'agent.thinking')]
    .map((event) => JSON.stringify(event))
    .concat(['', 'not json', JSON.stringify({ nope: true })])
    .join('\n');
  await writeFile(recordFile, JSON.stringify(record, null, 2), 'utf8');
  await writeFile(eventsFile, lines, 'utf8');
  return { recordFile, eventsFile, id: record.id };
}

describe('seedAgents', () => {
  it('inserts the agent catalog and stays idempotent', async () => {
    expect(await seedAgents(handle.db)).toBe(5);
    expect(await seedAgents(handle.db)).toBe(5);
    const rows = await handle.db.select().from(agents).orderBy(agents.id);
    expect(rows.map((row) => row.id)).toEqual(['claude-code', 'codex', 'fake', 'gemini-cli', 'opencode']);
    expect(rows.find((row) => row.id === 'claude-code')?.vendor).toBe('Anthropic');
  });
});

describe('seedDemoBattle', () => {
  it('loads the record, events and artifacts as a public demo battle', async () => {
    const demo = await writeDemo();
    const files = { recordFile: demo.recordFile, eventsFile: demo.eventsFile };
    expect(demoFilesExist(files)).toBe(true);

    const result = await seedDemoBattle(handle.db, files);
    expect(result).toMatchObject({
      battleId: demo.id,
      created: true,
      events: 2,
      eventsStored: 2,
      eventsInvalid: 2,
    });
    expect(result.artifacts).toBe(2);

    const found = await getBattle(handle.db, demo.id);
    expect(found?.battle.visibility).toBe('public');
    expect(found?.battle.demo).toBe(true);
    expect(await getBattleForViewer(handle.db, demo.id, null)).not.toBeNull();
    expect(await countEvents(handle.db, demo.id)).toBe(2);
    expect((await listArtifacts(handle.db, demo.id)).map((row) => row.kind).sort()).toEqual([
      'diff',
      'final_response',
    ]);

    const second = await seedDemoBattle(handle.db, files);
    expect(second).toMatchObject({ created: false, eventsStored: 0, artifacts: 2 });
    expect(await countEvents(handle.db, demo.id)).toBe(2);
    expect(await listArtifacts(handle.db, demo.id)).toHaveLength(2);
  });

  it('reports missing demo files instead of throwing', async () => {
    const files = demoFilesFor(dir);
    expect(demoFilesExist(files)).toBe(false);
  });

  it('skips unparseable event lines', async () => {
    const demo = await writeDemo();
    const parsed = readEventsFile(demo.eventsFile);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.invalid).toBe(2);
  });

  it('finds the workspace root from the package', () => {
    const root = findRepoRoot();
    expect(root).not.toBeNull();
    expect(path.basename(root as string)).toBe('harness-arena');
  });
});
