import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { battleRecordSchema } from '@harness-arena/protocol';
import type { ArenaEvent, BattleListItem, BattleRecord, Side } from '@harness-arena/protocol';

/**
 * On-disk state under ARENA_HOME (default `~/.harness-arena`):
 *
 *   config.json                       device token and preferences (mode 0600, atomic writes)
 *   repos/<sha1(source)>.git          bare mirrors; the user's own checkout is never modified
 *   harnesses/<sha1(source)>/         harness checkouts
 *   battles/<battleId>/battle.json    the battle record (atomic writes)
 *   battles/<battleId>/events.ndjson  append-only event log
 *   battles/<battleId>/runs/<side>/   per-run workspace and raw logs
 *   battles/<battleId>/report.html    self-contained local report
 *   battles/<battleId>/logs/          engine logs
 */

/** A lock older than this is treated as abandoned even if the pid still resolves. */
export const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

const BATTLE_ID_RE = /^btl_[0-9a-z]{8,32}$/;

export interface ArenaConfig {
  /** device token from `arena login`; never logged, never printed */
  token?: string | null;
  tokenPrefix?: string | null;
  serverUrl?: string | null;
  deviceName?: string | null;
  user?: { id: string; login: string; name: string | null } | null;
  defaultPrivacyUpload?: 'none' | 'metrics' | 'events' | 'full';
  [key: string]: unknown;
}

export interface BattlePaths {
  home: string;
  dir: string;
  record: string;
  events: string;
  report: string;
  logs: string;
  lock: string;
  runs: Record<Side, string>;
  workspaces: Record<Side, string>;
  rawLogs: Record<Side, string>;
}

export interface BattleLock {
  path: string;
  pid: number;
  release(): Promise<void>;
}

export interface StateStore {
  readonly home: string;
  paths(battleId: string): BattlePaths;
  /** absolute path of the bare mirror for a repository source */
  mirrorPath(source: string): string;
  /** absolute path of the checkout directory for a harness source */
  harnessPath(source: string): string;
  saveRecord(record: BattleRecord): Promise<void>;
  loadRecord(id: string): Promise<BattleRecord | null>;
  listBattles(opts?: { limit?: number }): Promise<BattleListItem[]>;
  appendEvents(id: string, events: ArenaEvent[]): Promise<void>;
  readEvents(id: string, opts?: { afterSeq?: number }): Promise<ArenaEvent[]>;
  getConfig(): Promise<ArenaConfig>;
  setConfig(patch: Partial<ArenaConfig>): Promise<ArenaConfig>;
  lock(battleId: string): Promise<BattleLock>;
  removeBattle(id: string): Promise<void>;
}

/** ARENA_HOME, else `~/.harness-arena`. */
export function defaultHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.ARENA_HOME;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.harness-arena');
}

/** Stable directory key for a repository or harness source. */
export function sourceKey(source: string): string {
  return crypto.createHash('sha1').update(source.trim()).digest('hex');
}

function assertBattleId(id: string): void {
  if (!BATTLE_ID_RE.test(id)) throw new Error('not a battle id: ' + JSON.stringify(id));
}

async function atomicWrite(file: string, data: string, mode?: number): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    '.' + path.basename(file) + '.' + crypto.randomBytes(6).toString('hex') + '.tmp',
  );
  const handle = await fsp.open(tmp, 'w', mode ?? 0o666);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (mode !== undefined) {
    try {
      await fsp.chmod(tmp, mode);
    } catch {
      // Windows has no POSIX modes; the ACL inherited from the home directory applies.
    }
  }
  // fs.rename replaces an existing destination on POSIX and on Windows (MOVEFILE_REPLACE_EXISTING).
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function createStateStore(home?: string): StateStore {
  const root = home ? path.resolve(home) : defaultHome();
  const configFile = path.join(root, 'config.json');

  function paths(battleId: string): BattlePaths {
    assertBattleId(battleId);
    const dir = path.join(root, 'battles', battleId);
    const runDir = (side: Side) => path.join(dir, 'runs', side);
    return {
      home: root,
      dir,
      record: path.join(dir, 'battle.json'),
      events: path.join(dir, 'events.ndjson'),
      report: path.join(dir, 'report.html'),
      logs: path.join(dir, 'logs'),
      lock: path.join(dir, 'battle.lock'),
      runs: { a: runDir('a'), b: runDir('b') },
      workspaces: { a: path.join(runDir('a'), 'workspace'), b: path.join(runDir('b'), 'workspace') },
      rawLogs: { a: path.join(runDir('a'), 'raw.log'), b: path.join(runDir('b'), 'raw.log') },
    };
  }

  async function loadRecord(id: string): Promise<BattleRecord | null> {
    const file = paths(id).record;
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return null;
    }
    const parsed = battleRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  }

  function toListItem(record: BattleRecord): BattleListItem {
    return {
      id: record.id,
      title: record.spec.title ?? record.task.title,
      status: record.status,
      visibility: record.spec.visibility,
      winner: record.verdict?.winner ?? null,
      a: {
        label: record.runs.a.label,
        agent: record.runs.a.agent.id,
        harness: record.runs.a.harness.name,
      },
      b: {
        label: record.runs.b.label,
        agent: record.runs.b.agent.id,
        harness: record.runs.b.harness.name,
      },
      demo: record.demo,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
    };
  }

  return {
    home: root,
    paths,
    mirrorPath: (source) => path.join(root, 'repos', sourceKey(source) + '.git'),
    harnessPath: (source) => path.join(root, 'harnesses', sourceKey(source)),

    async saveRecord(record) {
      const parsed = battleRecordSchema.safeParse(record);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
          .join('; ');
        throw new Error('refusing to save an invalid battle record: ' + detail);
      }
      await atomicWrite(paths(record.id).record, JSON.stringify(parsed.data, null, 2) + '\n');
    },

    loadRecord,

    async listBattles(opts = {}) {
      const dir = path.join(root, 'battles');
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        return [];
      }
      const items: BattleListItem[] = [];
      for (const entry of entries) {
        if (!BATTLE_ID_RE.test(entry)) continue;
        const record = await loadRecord(entry);
        if (record) items.push(toListItem(record));
      }
      items.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
      return typeof opts.limit === 'number' ? items.slice(0, Math.max(0, opts.limit)) : items;
    },

    async appendEvents(id, events) {
      if (events.length === 0) return;
      const file = paths(id).events;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const payload = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const handle = await fsp.open(file, 'a');
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async readEvents(id, opts = {}) {
      const file = paths(id).events;
      if (!fs.existsSync(file)) return [];
      const after = opts.afterSeq;
      const out: ArenaEvent[] = [];
      const stream = fs.createReadStream(file, { encoding: 'utf8' });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          let value: unknown;
          try {
            value = JSON.parse(trimmed);
          } catch {
            // A truncated final line (power loss mid-write) or a corrupt line is skipped, not fatal.
            continue;
          }
          const event = value as ArenaEvent;
          if (!event || typeof event !== 'object' || typeof event.seq !== 'number') continue;
          if (typeof after === 'number' && event.seq <= after) continue;
          out.push(event);
        }
      } finally {
        lines.close();
        stream.close();
      }
      return out;
    },

    async getConfig() {
      try {
        const text = await fsp.readFile(configFile, 'utf8');
        const value = JSON.parse(text) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as ArenaConfig;
        return {};
      } catch {
        return {};
      }
    },

    async setConfig(patch) {
      const current = await this.getConfig();
      const next: ArenaConfig = { ...current, ...patch };
      await atomicWrite(configFile, JSON.stringify(next, null, 2) + '\n', 0o600);
      return next;
    },

    async lock(battleId) {
      const file = paths(battleId).lock;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const handle = await fsp.open(file, 'wx');
          await handle.writeFile(body, 'utf8');
          await handle.close();
          return {
            path: file,
            pid: process.pid,
            release: async () => {
              await fsp.rm(file, { force: true });
            },
          };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          const existing = await fsp.readFile(file, 'utf8').catch(() => '');
          let pid = 0;
          let startedAt = 0;
          try {
            const parsed = JSON.parse(existing) as { pid?: number; startedAt?: string };
            pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
            startedAt = parsed.startedAt ? Date.parse(parsed.startedAt) : 0;
          } catch {
            // An unparseable lock file is stale by definition.
          }
          const age = startedAt ? Date.now() - startedAt : Number.POSITIVE_INFINITY;
          const stale = pid === process.pid || !pidAlive(pid) || age > LOCK_STALE_MS;
          if (!stale) throw new Error('battle ' + battleId + ' is locked by pid ' + pid);
          await fsp.rm(file, { force: true });
        }
      }
      throw new Error('could not acquire the lock for battle ' + battleId);
    },

    async removeBattle(id) {
      assertBattleId(id);
      await fsp.rm(paths(id).dir, { recursive: true, force: true });
    },
  };
}
