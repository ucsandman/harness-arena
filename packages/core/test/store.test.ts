import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { battleSpecSchema } from '@harness-arena/protocol';
import type { ArenaEvent, BattleRecord } from '@harness-arena/protocol';
import { LOCK_STALE_MS, createStateStore, defaultHome, sourceKey } from '../src/store.js';
import { makeEvent, makeRecord, removeDir, tempDir } from './helpers.js';

const SPEC = battleSpecSchema.parse({
  version: 1,
  task: { kind: 'prompt', prompt: 'Fix it.' },
  repository: { source: 'empty' },
  competitors: {
    a: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
    b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
  },
});

let home: string;

beforeEach(() => {
  home = tempDir('store');
});

afterEach(() => {
  removeDir(home);
});

function recordWith(patch: Partial<BattleRecord>): BattleRecord {
  return makeRecord({ spec: SPEC, record: patch });
}

describe('defaultHome', () => {
  it('prefers ARENA_HOME', () => {
    expect(defaultHome({ ARENA_HOME: path.join(home, 'custom') })).toBe(
      path.resolve(path.join(home, 'custom')),
    );
  });

  it('falls back to a dot directory in the user home', () => {
    expect(defaultHome({})).toMatch(/[\\/]\.harness-arena$/);
  });
});

describe('paths and source keys', () => {
  it('lays out one directory per battle', () => {
    const store = createStateStore(home);
    const record = recordWith({});
    const paths = store.paths(record.id);
    expect(paths.dir).toBe(path.join(home, 'battles', record.id));
    expect(paths.record).toBe(path.join(paths.dir, 'battle.json'));
    expect(paths.events).toBe(path.join(paths.dir, 'events.ndjson'));
    expect(paths.report).toBe(path.join(paths.dir, 'report.html'));
    expect(paths.workspaces.a).toBe(path.join(paths.dir, 'runs', 'a', 'workspace'));
    expect(paths.workspaces.b).toBe(path.join(paths.dir, 'runs', 'b', 'workspace'));
  });

  it('refuses an id that is not a battle id', () => {
    const store = createStateStore(home);
    expect(() => store.paths('../../etc')).toThrow(/not a battle id/);
  });

  it('derives stable mirror and harness directories from the source', () => {
    const store = createStateStore(home);
    expect(store.mirrorPath('https://github.com/a/b')).toBe(
      path.join(home, 'repos', sourceKey('https://github.com/a/b') + '.git'),
    );
    expect(store.harnessPath('https://github.com/a/b')).toBe(
      path.join(home, 'harnesses', sourceKey('https://github.com/a/b')),
    );
  });
});

describe('records', () => {
  it('saves atomically and reloads', async () => {
    const store = createStateStore(home);
    const record = recordWith({});
    await store.saveRecord(record);
    const loaded = await store.loadRecord(record.id);
    expect(loaded?.id).toBe(record.id);
    // No temp files are left behind.
    const files = fs.readdirSync(store.paths(record.id).dir);
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('refuses to save an invalid record instead of writing junk', async () => {
    const store = createStateStore(home);
    const broken = { ...recordWith({}), status: 'not-a-status' } as unknown as BattleRecord;
    await expect(store.saveRecord(broken)).rejects.toThrow(/invalid battle record/);
  });

  it('returns null for a missing record', async () => {
    const store = createStateStore(home);
    expect(await store.loadRecord('btl_00000000000000zz')).toBeNull();
  });

  it('lists battles newest first and honours the limit', async () => {
    const store = createStateStore(home);
    const older = recordWith({ createdAt: new Date(1000).toISOString() });
    const newer = recordWith({ createdAt: new Date(9000).toISOString() });
    await store.saveRecord(older);
    await store.saveRecord(newer);
    const all = await store.listBattles();
    expect(all.map((b) => b.id)).toEqual([newer.id, older.id]);
    expect(all[0]?.a.label).toBe('Agnostic AI');
    const limited = await store.listBattles({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.id).toBe(newer.id);
  });

  it('ignores directories that are not battles', async () => {
    const store = createStateStore(home);
    fs.mkdirSync(path.join(home, 'battles', 'not-a-battle'), { recursive: true });
    expect(await store.listBattles()).toEqual([]);
  });

  it('removes a battle directory', async () => {
    const store = createStateStore(home);
    const record = recordWith({});
    await store.saveRecord(record);
    await store.removeBattle(record.id);
    expect(fs.existsSync(store.paths(record.id).dir)).toBe(false);
  });
});

describe('events', () => {
  const battleId = 'btl_0000000000000abc';

  function events(count: number): ArenaEvent[] {
    return Array.from({ length: count }, (_, i) =>
      makeEvent('agent.thinking', { chars: i }, { seq: i + 1, battleId }),
    );
  }

  it('appends and reads back in order', async () => {
    const store = createStateStore(home);
    await store.appendEvents(battleId, events(3));
    await store.appendEvents(battleId, [makeEvent('agent.thinking', { chars: 99 }, { seq: 4, battleId })]);
    const read = await store.readEvents(battleId);
    expect(read.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('filters by afterSeq', async () => {
    const store = createStateStore(home);
    await store.appendEvents(battleId, events(5));
    const read = await store.readEvents(battleId, { afterSeq: 3 });
    expect(read.map((e) => e.seq)).toEqual([4, 5]);
  });

  it('tolerates a truncated last line', async () => {
    const store = createStateStore(home);
    await store.appendEvents(battleId, events(2));
    const file = store.paths(battleId).events;
    fs.appendFileSync(file, '{"v":1,"id":"evt_broken","se');
    const read = await store.readEvents(battleId);
    expect(read.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('returns nothing when there is no log yet', async () => {
    const store = createStateStore(home);
    expect(await store.readEvents(battleId)).toEqual([]);
    await store.appendEvents(battleId, []);
    expect(await store.readEvents(battleId)).toEqual([]);
  });
});

describe('config', () => {
  it('starts empty, merges patches and writes 0600 on POSIX', async () => {
    const store = createStateStore(home);
    expect(await store.getConfig()).toEqual({});
    await store.setConfig({ serverUrl: 'https://arena.test' });
    const next = await store.setConfig({ token: 'device-token-value' });
    expect(next.serverUrl).toBe('https://arena.test');
    expect(next.token).toBe('device-token-value');
    expect((await store.getConfig()).token).toBe('device-token-value');
    const file = path.join(home, 'config.json');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } else {
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it('treats an unreadable config as empty', async () => {
    const store = createStateStore(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), 'not json');
    expect(await store.getConfig()).toEqual({});
  });
});

describe('locks', () => {
  const battleId = 'btl_0000000000000loc';

  it('writes a lock with the pid and releases it', async () => {
    const store = createStateStore(home);
    const lock = await store.lock(battleId);
    expect(lock.pid).toBe(process.pid);
    expect(fs.existsSync(lock.path)).toBe(true);
    await lock.release();
    expect(fs.existsSync(lock.path)).toBe(false);
  });

  it('refuses when a live foreign pid holds the lock', async () => {
    const store = createStateStore(home);
    const file = store.paths(battleId).lock;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // process.ppid is alive and is not this process.
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    await expect(store.lock(battleId)).rejects.toThrow(/locked by pid/);
  });

  it('steals a lock held by a dead pid', async () => {
    const store = createStateStore(home);
    const file = store.paths(battleId).lock;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 999_999_998, startedAt: new Date().toISOString() }));
    const lock = await store.lock(battleId);
    expect(lock.pid).toBe(process.pid);
    await lock.release();
  });

  it('steals a lock that is older than the stale window', async () => {
    const store = createStateStore(home);
    const file = store.paths(battleId).lock;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: process.ppid,
        startedAt: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString(),
      }),
    );
    const lock = await store.lock(battleId);
    expect(lock.pid).toBe(process.pid);
    await lock.release();
  });

  it('steals an unparseable lock file', async () => {
    const store = createStateStore(home);
    const file = store.paths(battleId).lock;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'garbage');
    const lock = await store.lock(battleId);
    await lock.release();
  });
});
