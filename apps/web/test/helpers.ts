import { WEB_URL } from './setup-env';
import { readFileSync } from 'node:fs';
import { battleRecordSchema, makeId, type ArenaEvent, type BattleRecord } from '@harness-arena/protocol';
import {
  createDevice,
  demoFilesFor,
  findRepoRoot,
  readEventsFile,
  upsertGithubUser,
  type ArenaDatabase,
  type Device,
  type User,
} from '@harness-arena/database';
import { generateDeviceToken } from '@/lib/auth';
import { db } from '@/lib/db';

/** Shared fixtures for the web tests. No network, no agent CLI, no temp files. */

export async function testDb(): Promise<ArenaDatabase> {
  return db();
}

export async function makeUser(login: string, githubId: number): Promise<User> {
  const dbh = await db();
  return upsertGithubUser(dbh, { githubId, login, name: `${login} tester`, avatarUrl: null, email: null });
}

export interface TestDevice {
  token: string;
  device: Device;
  user: User;
}

export async function makeDevice(
  login: string,
  githubId: number,
  name = 'test machine',
): Promise<TestDevice> {
  const dbh = await db();
  const user = await makeUser(login, githubId);
  const token = generateDeviceToken();
  const device = await createDevice(dbh, {
    userId: user.id,
    name,
    tokenHash: token.tokenHash,
    tokenPrefix: token.tokenPrefix,
  });
  return { token: token.token, device, user };
}

function repoRoot(): string {
  const root = findRepoRoot();
  if (!root) throw new Error('could not locate the repository root from the database package');
  return root;
}

/**
 * The exported demo battle in examples/demo, optionally re-identified so a test owns it. A new battle
 * id also needs new run ids: `battle_runs.id` is a global primary key, so two battles may never share
 * the run ids that came out of one record.
 */
export function demoRecord(overrides: Partial<BattleRecord> = {}): BattleRecord {
  const files = demoFilesFor(repoRoot());
  const raw = JSON.parse(readFileSync(files.recordFile, 'utf8')) as unknown;
  const record = battleRecordSchema.parse(raw);
  const reIdentified =
    overrides.id && overrides.id !== record.id
      ? {
          runs: {
            a: { ...record.runs.a, id: makeId('run') },
            b: { ...record.runs.b, id: makeId('run') },
          },
        }
      : {};
  return battleRecordSchema.parse({ ...record, ...reIdentified, ...overrides });
}

export function demoEvents(battleId?: string, count?: number): ArenaEvent[] {
  const files = demoFilesFor(repoRoot());
  const { events } = readEventsFile(files.eventsFile);
  const sliced = count === undefined ? events : events.slice(0, count);
  return battleId === undefined ? sliced : sliced.map((event) => ({ ...event, battleId }));
}

export function freshBattleId(): string {
  return makeId('battle');
}

export function url(path: string): string {
  return `${WEB_URL}${path}`;
}

export function jsonRequest(
  path: string,
  body: unknown,
  opts: { method?: string; token?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(url(path), { method: opts.method ?? 'POST', headers, body: JSON.stringify(body) });
}

export function getRequest(path: string, opts: { token?: string; signal?: AbortSignal } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(url(path), { headers, ...(opts.signal ? { signal: opts.signal } : {}) });
}

export function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

export async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
