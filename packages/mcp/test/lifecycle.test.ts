import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BATTLE_STATUSES,
  battleRecordSchema,
  isTerminalBattleStatus,
  nextBattleStatuses,
  type BattleStatus,
} from '@harness-arena/protocol';
import { BattleRunner, type RunHooks } from '../src/runner.js';
import { callTool, connect, removeDir, seedExportedBattle, tempDir, type Connected } from './helpers.js';

/** The battle lifecycle as an agent sees it through the MCP server: descriptions, data fields, handles. */

let home: string;
let session: Connected;
let battleId: string;

beforeAll(async () => {
  home = tempDir('lifecycle');
  battleId = seedExportedBattle(home).id;
  session = await connect({ home, deps: { exampleHarnessDir: null } });
});

afterAll(async () => {
  await session.close();
  removeDir(home);
});

describe('battle lifecycle through the MCP tools', () => {
  it('names every battle status in the get and list descriptions', async () => {
    const listed = await session.client.listTools();
    for (const name of ['arena_get_battle', 'arena_list_battles']) {
      const description = listed.tools.find((t) => t.name === name)?.description ?? '';
      for (const status of BATTLE_STATUSES) expect(description, name + ' / ' + status).toContain(status);
    }
  });

  it('arena_get_battle reports terminal and allowedNext from the table', async () => {
    const answer = await callTool(session.client, 'arena_get_battle', { id: battleId });
    expect(answer.isError).toBe(false);
    const status = answer.data.status as BattleStatus;
    expect(answer.data.allowedNext).toEqual([...nextBattleStatuses(status)]);
    expect(answer.data.terminal).toBe(isTerminalBattleStatus(status));
  });

  it('arena_list_battles gives each row its allowedNext', async () => {
    const answer = await callTool(session.client, 'arena_list_battles');
    expect(answer.isError).toBe(false);
    expect(answer.data.battles.length).toBeGreaterThan(0);
    for (const row of answer.data.battles as Array<{ status: BattleStatus; allowedNext: string[] }>) {
      expect(row.allowedNext).toEqual([...nextBattleStatuses(row.status)]);
    }
  });
});

describe('the in-memory battle handle', () => {
  it('starts at pending and only moves forward, dropping a backward update', async () => {
    const runner = new BattleRunner();
    const id = 'btl_lifecycle00000001';
    const seen: BattleStatus[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observe = (): void => {
      const handle = runner.get(id);
      if (handle) seen.push(handle.status);
    };

    const started = await runner.start({
      trusted: false,
      waitMs: 0,
      run: async (hooks: RunHooks) => {
        hooks.onEvent({ battleId: id } as Parameters<RunHooks['onEvent']>[0]);
        observe();
        for (const status of ['preparing', 'running', 'preparing', 'evaluating'] as const) {
          hooks.onStatus(status);
          observe();
        }
        await gate;
        return battleRecordSchema.parse({ ...seededRecord(), id, status: 'completed' });
      },
    });
    expect(started.kind).toBe('started');
    expect(seen).toEqual(['pending', 'preparing', 'running', 'running', 'evaluating']);

    release();
    expect(await runner.idle()).toBe(true);
    expect(runner.get(id)?.status).toBe('completed');
  });
});

/** The exported demo record this suite copied into its ARENA_HOME. */
function seededRecord(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, 'battles', battleId, 'battle.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}
