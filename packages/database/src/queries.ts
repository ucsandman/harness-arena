import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  ArenaEvent,
  BattleListItem,
  BattleRecord,
  IntegrityReport,
  MetricKey,
  MetricValue,
  RatingCategory,
  RunRecord,
  Verdict,
  Visibility,
} from '@harness-arena/protocol';
import { EVENT_LIMITS, battleIdSchema, makeId } from '@harness-arena/protocol';
import type { ArenaDatabase } from './client.js';
import { extractRows } from './client.js';
import type {
  Artifact,
  Battle,
  BattleRun,
  Device,
  DeviceCode,
  EventRow,
  Harness,
  HarnessVersion,
  Session,
  User,
} from './schema/index.js';
import {
  agents,
  artifacts,
  battleRuns,
  battles,
  deviceCodes,
  devices,
  evaluations,
  events,
  harnessVersions,
  harnesses,
  metrics,
  ratingEvents,
  ratings,
  repositories,
  sessions,
  tasks,
  users,
} from './schema/index.js';
import {
  agentCatalogEntry,
  byteLength,
  frameworkForAgent,
  harnessDisplayName,
  harnessSlug,
  harnessSourceUrl,
  repositoryDisplayName,
  repositoryIdFor,
  taskIdFor,
  toDate,
} from './derive.js';
import { battleFingerprint, computeBattleIntegrity, ratingEligibleFor } from './integrity.js';
import { ratingCategoriesFor } from './ratings.js';

/**
 * Every helper takes the database (or a transaction handle) as its first argument, so the web app
 * can compose them inside its own transactions. Nothing here logs; callers own logging.
 */

// ---- users -------------------------------------------------------------------------------------

export interface GithubUserInput {
  githubId: number;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
}

export async function upsertGithubUser(db: ArenaDatabase, input: GithubUserInput): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      id: makeId('user'),
      githubId: input.githubId,
      login: input.login,
      name: input.name ?? null,
      avatarUrl: input.avatarUrl ?? null,
      email: input.email ?? null,
    })
    .onConflictDoUpdate({
      target: users.githubId,
      set: {
        login: input.login,
        name: input.name ?? null,
        avatarUrl: input.avatarUrl ?? null,
        email: input.email ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error('upsertGithubUser: no row returned');
  return row;
}

export async function getUserById(db: ArenaDatabase, id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function getUserByLogin(db: ArenaDatabase, login: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.login, login)).limit(1);
  return row ?? null;
}

// ---- sessions ----------------------------------------------------------------------------------

/** `tokenHash` is the sha256 of the cookie value; the raw token never reaches the database. */
export async function createSession(
  db: ArenaDatabase,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  userAgent?: string | null,
): Promise<Session> {
  const [row] = await db
    .insert(sessions)
    .values({ id: tokenHash, userId, expiresAt, userAgent: userAgent ?? null })
    .onConflictDoUpdate({ target: sessions.id, set: { expiresAt, userAgent: userAgent ?? null } })
    .returning();
  if (!row) throw new Error('createSession: no row returned');
  return row;
}

/** Returns null for an unknown or expired session. */
export async function getSessionUser(
  db: ArenaDatabase,
  tokenHash: string,
  now: Date = new Date(),
): Promise<{ user: User; session: Session } | null> {
  const [row] = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

export async function deleteSession(db: ArenaDatabase, tokenHash: string): Promise<boolean> {
  const deleted = await db.delete(sessions).where(eq(sessions.id, tokenHash)).returning({ id: sessions.id });
  return deleted.length > 0;
}

export async function deleteUserSessions(db: ArenaDatabase, userId: string): Promise<number> {
  const deleted = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  return deleted.length;
}

export async function deleteExpiredSessions(db: ArenaDatabase, now: Date = new Date()): Promise<number> {
  const deleted = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id });
  return deleted.length;
}

// ---- device flow -------------------------------------------------------------------------------

export interface CreateDeviceCodeInput {
  deviceCodeHash: string;
  userCode: string;
  deviceName: string;
  expiresAt: Date;
}

export async function createDeviceCode(db: ArenaDatabase, input: CreateDeviceCodeInput): Promise<DeviceCode> {
  const [row] = await db
    .insert(deviceCodes)
    .values({
      id: `dcd_${makeId('device').slice(4)}`,
      deviceCodeHash: input.deviceCodeHash,
      userCode: input.userCode.toUpperCase(),
      deviceName: input.deviceName,
      expiresAt: input.expiresAt,
    })
    .returning();
  if (!row) throw new Error('createDeviceCode: no row returned');
  return row;
}

export async function getDeviceCodeByUserCode(
  db: ArenaDatabase,
  userCode: string,
): Promise<DeviceCode | null> {
  const [row] = await db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.userCode, userCode.toUpperCase()))
    .limit(1);
  return row ?? null;
}

export async function getDeviceCodeByHash(
  db: ArenaDatabase,
  deviceCodeHash: string,
): Promise<DeviceCode | null> {
  const [row] = await db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.deviceCodeHash, deviceCodeHash))
    .limit(1);
  return row ?? null;
}

/** Approve a pending, unexpired code. Returns null when it is already decided or expired. */
export async function approveDeviceCode(
  db: ArenaDatabase,
  id: string,
  userId: string,
  now: Date = new Date(),
): Promise<DeviceCode | null> {
  const [row] = await db
    .update(deviceCodes)
    .set({ status: 'approved', userId, approvedAt: now })
    .where(and(eq(deviceCodes.id, id), eq(deviceCodes.status, 'pending'), gt(deviceCodes.expiresAt, now)))
    .returning();
  return row ?? null;
}

export async function denyDeviceCode(db: ArenaDatabase, id: string): Promise<DeviceCode | null> {
  const [row] = await db
    .update(deviceCodes)
    .set({ status: 'denied' })
    .where(and(eq(deviceCodes.id, id), eq(deviceCodes.status, 'pending')))
    .returning();
  return row ?? null;
}

/** Marks pending codes past their expiry as expired. Returns how many were changed. */
export async function expireStaleDeviceCodes(db: ArenaDatabase, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(deviceCodes)
    .set({ status: 'expired' })
    .where(and(eq(deviceCodes.status, 'pending'), lt(deviceCodes.expiresAt, now)))
    .returning({ id: deviceCodes.id });
  return rows.length;
}

// ---- devices -----------------------------------------------------------------------------------

export interface CreateDeviceInput {
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes?: string[];
}

export async function createDevice(db: ArenaDatabase, input: CreateDeviceInput): Promise<Device> {
  const [row] = await db
    .insert(devices)
    .values({
      id: makeId('device'),
      userId: input.userId,
      name: input.name,
      tokenHash: input.tokenHash,
      tokenPrefix: input.tokenPrefix,
      ...(input.scopes ? { scopes: input.scopes } : {}),
    })
    .returning();
  if (!row) throw new Error('createDevice: no row returned');
  return row;
}

/**
 * Authenticate a CLI token. Revoked devices never match. Touches `last_used_at` in the same
 * statement so authentication stays a single round trip.
 */
export async function getDeviceByTokenHash(
  db: ArenaDatabase,
  tokenHash: string,
  now: Date = new Date(),
): Promise<{ device: Device; user: User } | null> {
  const [device] = await db
    .update(devices)
    .set({ lastUsedAt: now })
    .where(and(eq(devices.tokenHash, tokenHash), isNull(devices.revokedAt)))
    .returning();
  if (!device) return null;
  const user = await getUserById(db, device.userId);
  if (!user) return null;
  return { device, user };
}

export async function listDevices(db: ArenaDatabase, userId: string): Promise<Device[]> {
  return db.select().from(devices).where(eq(devices.userId, userId)).orderBy(desc(devices.createdAt));
}

export async function revokeDevice(
  db: ArenaDatabase,
  userId: string,
  deviceId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(devices)
    .set({ revokedAt: now })
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)))
    .returning({ id: devices.id });
  return rows.length > 0;
}

// ---- battles -----------------------------------------------------------------------------------

export interface UpsertBattleInput {
  record: BattleRecord;
  ownerUserId?: string | null;
  deviceId?: string | null;
  visibility?: Visibility;
  /** overrides record.demo; the seeder uses it to mark the bundled example battle */
  demo?: boolean;
}

export interface UpsertBattleResult {
  id: string;
  created: boolean;
  taskId: string;
  repositoryId: string | null;
  harnessIds: { a: string; b: string };
  /** the server's own integrity verdict, as stored on the battle */
  integrity: IntegrityReport;
  /** integrity.eligible AND the battle finished: may this battle move a rating */
  ratingEligible: boolean;
}

async function upsertAgent(db: ArenaDatabase, agentId: string): Promise<void> {
  const entry = agentCatalogEntry(agentId);
  await db
    .insert(agents)
    .values({ id: agentId, displayName: entry.displayName, vendor: entry.vendor, homepage: entry.homepage })
    .onConflictDoNothing({ target: agents.id });
}

async function upsertHarnessFromRun(
  db: ArenaDatabase,
  run: RunRecord,
): Promise<{ harnessId: string; versionId: string }> {
  const slug = harnessSlug(run.harness);
  const [harnessRow] = await db
    .insert(harnesses)
    .values({
      id: makeId('harness'),
      slug,
      name: harnessDisplayName(run.harness),
      sourceKind: run.harness.kind,
      sourceUrl: harnessSourceUrl(run.harness),
      description: run.harness.manifest?.description ?? null,
      framework: frameworkForAgent(run.agent.id),
    })
    .onConflictDoUpdate({
      target: harnesses.slug,
      // A battle upload may DISCOVER a harness but never rewrites the identity of a row that already
      // exists: name, sourceKind, sourceUrl (and the owner) belong to the import flow in
      // apps/web/lib/harness-import.ts, which re-inspects the repository itself. An upload only marks
      // the row as seen; anything else would let one account edit another account's catalog entry by
      // uploading a battle whose harness slugs to the same key.
      set: { updatedAt: new Date() },
    })
    .returning({ id: harnesses.id });
  if (!harnessRow) throw new Error(`upsertHarnessFromRun: no harness row for ${slug}`);

  const values = {
    id: makeId('harnessVersion'),
    harnessId: harnessRow.id,
    commit: run.harness.commit,
    manifest: run.harness.manifest,
  };
  const [versionRow] = await db
    .insert(harnessVersions)
    .values(values)
    .onConflictDoUpdate({
      target: [harnessVersions.harnessId, harnessVersions.commit],
      set: { manifest: run.harness.manifest },
    })
    .returning({ id: harnessVersions.id });
  if (!versionRow) throw new Error(`upsertHarnessFromRun: no version row for ${slug}`);
  return { harnessId: harnessRow.id, versionId: versionRow.id };
}

function metricRowsFor(
  battleId: string,
  side: 'a' | 'b',
  runMetrics: Partial<Record<MetricKey, MetricValue>>,
) {
  return Object.entries(runMetrics)
    .filter((entry): entry is [MetricKey, MetricValue] => Boolean(entry[1]))
    .map(([key, metric]) => ({ battleId, side, key, value: metric.value, status: metric.status }));
}

/**
 * Write a BattleRecord and everything derived from it in one transaction: task, repository, agents,
 * harnesses, harness versions, the two runs, the denormalized metrics, and the evaluation. Safe to
 * call repeatedly with an evolving record (the CLI patches a battle as it progresses).
 */
export async function upsertBattleFromRecord(
  db: ArenaDatabase,
  input: UpsertBattleInput,
): Promise<UpsertBattleResult> {
  const record = input.record;
  battleIdSchema.parse(record.id);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: battles.id })
      .from(battles)
      .where(eq(battles.id, record.id))
      .limit(1);
    const created = existing.length === 0;

    const taskId = taskIdFor(record.task);
    await tx
      .insert(tasks)
      .values({
        id: taskId,
        kind: record.task.source.kind,
        title: record.task.title,
        prompt: record.task.prompt,
        source: record.task.source,
      })
      .onConflictDoNothing({ target: tasks.id });

    let repositoryId: string | null = null;
    if (record.repository.kind !== 'empty' && record.repository.source) {
      const [repoRow] = await tx
        .insert(repositories)
        .values({
          id: repositoryIdFor(record.repository.source),
          source: record.repository.source,
          kind: record.repository.kind,
          displayName: repositoryDisplayName(record.repository.source, record.repository.kind),
        })
        .onConflictDoUpdate({
          target: repositories.source,
          set: { kind: record.repository.kind },
        })
        .returning({ id: repositories.id });
      repositoryId = repoRow?.id ?? null;
    }

    const harnessIds: Partial<Record<'a' | 'b', string>> = {};
    const versionIds: Partial<Record<'a' | 'b', string>> = {};
    for (const side of ['a', 'b'] as const) {
      const run = record.runs[side];
      await upsertAgent(tx, run.agent.id);
      const { harnessId, versionId } = await upsertHarnessFromRun(tx, run);
      harnessIds[side] = harnessId;
      versionIds[side] = versionId;
    }

    const visibility = input.visibility ?? record.spec.visibility;
    const demo = input.demo ?? record.demo;

    // Integrity is recomputed here on every upload and the client's own `record.integrity` is
    // discarded: eligibility is the server's verdict or it is worth nothing. A duplicate is another
    // battle that already carries this exact matchup fingerprint AND was itself rated, so re-running
    // the same matchup is fine until the first one counts.
    const checked: BattleRecord = { ...record, demo };
    const fingerprint = battleFingerprint(checked);
    let duplicateOf: string | null = null;
    if (fingerprint) {
      const [duplicate] = await tx
        .select({ id: battles.id })
        .from(battles)
        .where(
          and(
            eq(battles.fingerprint, fingerprint),
            ne(battles.id, record.id),
            eq(battles.ratingEligible, true),
            inArray(battles.winner, ['a', 'b', 'tie']),
          ),
        )
        .orderBy(asc(battles.createdAt), asc(battles.id))
        .limit(1);
      duplicateOf = duplicate?.id ?? null;
    }
    const integrity = computeBattleIntegrity(checked, { duplicateOf });
    const storedRecord: BattleRecord = { ...checked, integrity };
    const ratingEligible = ratingEligibleFor(storedRecord, integrity);
    const benchmark = record.spec.benchmark ?? null;

    const battleValues = {
      id: record.id,
      ownerUserId: input.ownerUserId ?? null,
      deviceId: input.deviceId ?? null,
      title: record.spec.title ?? record.task.title,
      status: record.status,
      visibility,
      mode: record.spec.mode,
      verificationKind: record.verification.kind,
      verificationEligible: record.verification.eligible,
      demo,
      taskId,
      repositoryId,
      repositoryCommit: record.repository.commit,
      spec: record.spec,
      record: storedRecord,
      winner: record.verdict?.winner ?? null,
      confidence: record.verdict?.confidence ?? null,
      category: record.spec.category ?? null,
      benchmarkVersionId: benchmark?.versionId ?? null,
      benchmarkTaskId: benchmark?.taskId ?? null,
      benchmarkTrial: benchmark?.trial ?? null,
      integrity,
      ratingEligible,
      fingerprint,
      arenaVersion: record.arenaVersion,
      createdAt: toDate(record.createdAt) ?? new Date(),
      startedAt: toDate(record.startedAt),
      completedAt: toDate(record.completedAt),
      updatedAt: new Date(),
    };
    await tx
      .insert(battles)
      .values(battleValues)
      .onConflictDoUpdate({
        target: battles.id,
        set: {
          ownerUserId: battleValues.ownerUserId,
          deviceId: battleValues.deviceId,
          title: battleValues.title,
          status: battleValues.status,
          visibility: battleValues.visibility,
          mode: battleValues.mode,
          verificationKind: battleValues.verificationKind,
          verificationEligible: battleValues.verificationEligible,
          demo: battleValues.demo,
          taskId: battleValues.taskId,
          repositoryId: battleValues.repositoryId,
          repositoryCommit: battleValues.repositoryCommit,
          spec: battleValues.spec,
          record: battleValues.record,
          winner: battleValues.winner,
          confidence: battleValues.confidence,
          category: battleValues.category,
          benchmarkVersionId: battleValues.benchmarkVersionId,
          benchmarkTaskId: battleValues.benchmarkTaskId,
          benchmarkTrial: battleValues.benchmarkTrial,
          integrity: battleValues.integrity,
          ratingEligible: battleValues.ratingEligible,
          fingerprint: battleValues.fingerprint,
          arenaVersion: battleValues.arenaVersion,
          startedAt: battleValues.startedAt,
          completedAt: battleValues.completedAt,
          updatedAt: battleValues.updatedAt,
        },
      });

    for (const side of ['a', 'b'] as const) {
      const run = record.runs[side];
      const runValues = {
        id: run.id,
        battleId: record.id,
        side,
        label: run.label,
        agentId: run.agent.id,
        harnessId: harnessIds[side] ?? null,
        harnessVersionId: versionIds[side] ?? null,
        status: run.status,
        model: run.agent.model,
        durationMs: run.durationMs === null ? null : Math.round(run.durationMs),
        exitCode: run.exitCode,
        metrics: run.metrics as Record<MetricKey, MetricValue>,
        invocation: run.invocation,
        error: run.error,
        startedAt: toDate(run.startedAt),
        completedAt: toDate(run.completedAt),
      };
      await tx
        .insert(battleRuns)
        .values(runValues)
        .onConflictDoUpdate({
          target: [battleRuns.battleId, battleRuns.side],
          set: {
            id: runValues.id,
            label: runValues.label,
            agentId: runValues.agentId,
            harnessId: runValues.harnessId,
            harnessVersionId: runValues.harnessVersionId,
            status: runValues.status,
            model: runValues.model,
            durationMs: runValues.durationMs,
            exitCode: runValues.exitCode,
            metrics: runValues.metrics,
            invocation: runValues.invocation,
            error: runValues.error,
            startedAt: runValues.startedAt,
            completedAt: runValues.completedAt,
          },
        });
    }

    // Metrics are a projection of the record: replace them wholesale so they can never go stale.
    await tx.delete(metrics).where(eq(metrics.battleId, record.id));
    const metricValues = [
      ...metricRowsFor(record.id, 'a', record.runs.a.metrics),
      ...metricRowsFor(record.id, 'b', record.runs.b.metrics),
    ];
    if (metricValues.length > 0) await tx.insert(metrics).values(metricValues);

    if (record.evaluation || record.verdict) {
      await tx.delete(evaluations).where(eq(evaluations.battleId, record.id));
      await tx.insert(evaluations).values({
        id: makeId('evaluation'),
        battleId: record.id,
        report: record.evaluation,
        verdict: record.verdict,
      });
    }

    return {
      id: record.id,
      created,
      taskId,
      repositoryId,
      harnessIds: { a: harnessIds.a as string, b: harnessIds.b as string },
      integrity,
      ratingEligible,
    };
  });
}

export interface BattleWithRuns {
  battle: Battle;
  runs: BattleRun[];
}

export async function getBattle(db: ArenaDatabase, id: string): Promise<BattleWithRuns | null> {
  const [battle] = await db.select().from(battles).where(eq(battles.id, id)).limit(1);
  if (!battle) return null;
  const runs = await db.select().from(battleRuns).where(eq(battleRuns.battleId, id)).orderBy(battleRuns.side);
  return { battle, runs };
}

/** Visibility gate: private battles are owner-only; unlisted and public are readable by anyone. */
export async function getBattleForViewer(
  db: ArenaDatabase,
  id: string,
  viewerUserId: string | null,
): Promise<BattleWithRuns | null> {
  const found = await getBattle(db, id);
  if (!found) return null;
  if (found.battle.visibility === 'private') {
    if (!viewerUserId || found.battle.ownerUserId !== viewerUserId) return null;
  }
  return found;
}

export interface ListBattlesOptions {
  viewerUserId?: string | null;
  ownerUserId?: string;
  visibility?: Visibility;
  limit?: number;
  cursor?: string | null;
}

export interface BattleListPage {
  items: BattleListItem[];
  nextCursor: string | null;
}

function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const separator = cursor.indexOf('|');
  if (separator < 0) return null;
  const createdAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

const runA = alias(battleRuns, 'run_a');
const runB = alias(battleRuns, 'run_b');
const harnessA = alias(harnesses, 'harness_a');
const harnessB = alias(harnesses, 'harness_b');

function listSelection() {
  return {
    id: battles.id,
    title: battles.title,
    status: battles.status,
    visibility: battles.visibility,
    winner: battles.winner,
    demo: battles.demo,
    createdAt: battles.createdAt,
    completedAt: battles.completedAt,
    aLabel: runA.label,
    aAgent: runA.agentId,
    aHarness: harnessA.slug,
    bLabel: runB.label,
    bAgent: runB.agentId,
    bHarness: harnessB.slug,
  };
}

type ListRow = {
  id: string;
  title: string;
  status: BattleListItem['status'];
  visibility: Visibility;
  winner: BattleListItem['winner'];
  demo: boolean;
  createdAt: Date;
  completedAt: Date | null;
  aLabel: string | null;
  aAgent: string | null;
  aHarness: string | null;
  bLabel: string | null;
  bAgent: string | null;
  bHarness: string | null;
};

function toListItem(row: ListRow): BattleListItem {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    visibility: row.visibility,
    winner: row.winner ?? null,
    a: { label: row.aLabel ?? 'A', agent: row.aAgent ?? 'unknown', harness: row.aHarness ?? 'vanilla' },
    b: { label: row.bLabel ?? 'B', agent: row.bAgent ?? 'unknown', harness: row.bHarness ?? 'vanilla' },
    demo: row.demo,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/**
 * The battle feed. Without a viewer only public battles are listed; a viewer additionally sees their
 * own battles. Unlisted battles are reachable by link (getBattleForViewer) but never listed.
 */
export async function listBattles(db: ArenaDatabase, opts: ListBattlesOptions = {}): Promise<BattleListPage> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const viewer = opts.viewerUserId ?? null;
  const conditions = [
    viewer
      ? or(eq(battles.visibility, 'public'), eq(battles.ownerUserId, viewer))
      : eq(battles.visibility, 'public'),
  ];
  if (opts.ownerUserId) conditions.push(eq(battles.ownerUserId, opts.ownerUserId));
  if (opts.visibility) conditions.push(eq(battles.visibility, opts.visibility));
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor) {
    conditions.push(
      or(
        lt(battles.createdAt, cursor.createdAt),
        and(eq(battles.createdAt, cursor.createdAt), lt(battles.id, cursor.id)),
      ),
    );
  }

  const rows = await db
    .select(listSelection())
    .from(battles)
    .leftJoin(runA, and(eq(runA.battleId, battles.id), eq(runA.side, 'a')))
    .leftJoin(harnessA, eq(harnessA.id, runA.harnessId))
    .leftJoin(runB, and(eq(runB.battleId, battles.id), eq(runB.side, 'b')))
    .leftJoin(harnessB, eq(harnessB.id, runB.harnessId))
    .where(and(...conditions))
    .orderBy(desc(battles.createdAt), desc(battles.id))
    .limit(limit);

  const items = rows.map(toListItem);
  const last = rows[rows.length - 1];
  return {
    items,
    nextCursor: rows.length === limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/** Every battle owned by a user, private ones included. */
export async function listUserBattles(
  db: ArenaDatabase,
  userId: string,
  limit = 50,
): Promise<BattleListItem[]> {
  const rows = await db
    .select(listSelection())
    .from(battles)
    .leftJoin(runA, and(eq(runA.battleId, battles.id), eq(runA.side, 'a')))
    .leftJoin(harnessA, eq(harnessA.id, runA.harnessId))
    .leftJoin(runB, and(eq(runB.battleId, battles.id), eq(runB.side, 'b')))
    .leftJoin(harnessB, eq(harnessB.id, runB.harnessId))
    .where(eq(battles.ownerUserId, userId))
    .orderBy(desc(battles.createdAt), desc(battles.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(toListItem);
}

export async function setBattleVisibility(
  db: ArenaDatabase,
  id: string,
  ownerUserId: string,
  visibility: Visibility,
): Promise<boolean> {
  const rows = await db
    .update(battles)
    .set({ visibility, updatedAt: new Date() })
    .where(and(eq(battles.id, id), eq(battles.ownerUserId, ownerUserId)))
    .returning({ id: battles.id });
  return rows.length > 0;
}

export async function deleteBattle(db: ArenaDatabase, id: string, ownerUserId: string): Promise<boolean> {
  const rows = await db
    .delete(battles)
    .where(and(eq(battles.id, id), eq(battles.ownerUserId, ownerUserId)))
    .returning({ id: battles.id });
  return rows.length > 0;
}

// ---- events ------------------------------------------------------------------------------------

export interface InsertEventsResult {
  accepted: number;
  rejected: number;
  capped: boolean;
  lastSeq: number | null;
}

export async function countEvents(db: ArenaDatabase, battleId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(eq(events.battleId, battleId));
  return row?.n ?? 0;
}

/**
 * Append events. Duplicate (battle_id, seq) pairs are ignored, so a client may safely retry a batch.
 * Storage stops at EVENT_LIMITS.maxEventsPerBattle; the overflow is reported, never silently dropped.
 */
export async function insertEvents(
  db: ArenaDatabase,
  battleId: string,
  incoming: ArenaEvent[],
): Promise<InsertEventsResult> {
  const [battle] = await db
    .select({ id: battles.id, eventsCapped: battles.eventsCapped })
    .from(battles)
    .where(eq(battles.id, battleId))
    .limit(1);
  if (!battle) throw new Error(`insertEvents: unknown battle ${battleId}`);
  if (incoming.length === 0) {
    return { accepted: 0, rejected: 0, capped: battle.eventsCapped, lastSeq: await maxSeq(db, battleId) };
  }

  const stored = await countEvents(db, battleId);
  const room = Math.max(0, EVENT_LIMITS.maxEventsPerBattle - stored);
  const admitted = incoming.slice(0, room);
  const capped = incoming.length > room;

  let accepted = 0;
  if (admitted.length > 0) {
    const rows = admitted.map((event) => ({
      battleId,
      seq: event.seq,
      id: event.id,
      runId: event.runId,
      side: event.side,
      type: event.type,
      ts: toDate(event.ts) ?? new Date(),
      tOffsetMs: Math.round(event.tOffsetMs),
      source: event.source,
      confidence: event.confidence,
      payload: event.payload as unknown as Record<string, unknown>,
    }));
    const inserted = await db
      .insert(events)
      .values(rows)
      .onConflictDoNothing({ target: [events.battleId, events.seq] })
      .returning({ seq: events.seq });
    accepted = inserted.length;
  }

  // Recounted rather than added up, so a concurrent batch cannot leave a wrong number behind.
  const total = await countEvents(db, battleId);
  await db
    .update(battles)
    .set({ eventCount: total, eventsCapped: battle.eventsCapped || capped, updatedAt: new Date() })
    .where(eq(battles.id, battleId));

  return {
    accepted,
    rejected: incoming.length - accepted,
    capped: battle.eventsCapped || capped,
    lastSeq: await maxSeq(db, battleId),
  };
}

async function maxSeq(db: ArenaDatabase, battleId: string): Promise<number | null> {
  const result = await db.execute(
    sql`select max(${events.seq}) as seq from ${events} where ${events.battleId} = ${battleId}`,
  );
  const first = extractRows(result)[0] as { seq?: number | string | null } | undefined;
  const value = first?.seq;
  return value === null || value === undefined ? null : Number(value);
}

export async function listEvents(
  db: ArenaDatabase,
  battleId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): Promise<EventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), EVENT_LIMITS.maxBatchEvents);
  const where =
    opts.afterSeq === undefined
      ? eq(events.battleId, battleId)
      : and(eq(events.battleId, battleId), gt(events.seq, opts.afterSeq));
  return db.select().from(events).where(where).orderBy(events.seq).limit(limit);
}

// ---- artifacts ---------------------------------------------------------------------------------

export interface UpsertArtifactInput {
  battleId: string;
  side: 'a' | 'b' | null;
  kind: Artifact['kind'];
  content: string;
  contentType?: string;
}

export async function upsertArtifact(db: ArenaDatabase, input: UpsertArtifactInput): Promise<Artifact> {
  const bytes = byteLength(input.content);
  const contentType = input.contentType ?? 'text/plain';
  const [row] = await db
    .insert(artifacts)
    .values({
      id: makeId('artifact'),
      battleId: input.battleId,
      side: input.side,
      kind: input.kind,
      content: input.content,
      contentType,
      bytes,
    })
    .onConflictDoUpdate({
      target: [artifacts.battleId, artifacts.side, artifacts.kind],
      set: { content: input.content, contentType, bytes, createdAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('upsertArtifact: no row returned');
  return row;
}

export async function getArtifact(
  db: ArenaDatabase,
  battleId: string,
  side: 'a' | 'b' | null,
  kind: Artifact['kind'],
): Promise<Artifact | null> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.battleId, battleId),
        side === null ? isNull(artifacts.side) : eq(artifacts.side, side),
        eq(artifacts.kind, kind),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Metadata only: artifact content can be megabytes, so it is fetched one at a time. */
export async function listArtifacts(
  db: ArenaDatabase,
  battleId: string,
): Promise<Omit<Artifact, 'content'>[]> {
  return db
    .select({
      id: artifacts.id,
      battleId: artifacts.battleId,
      side: artifacts.side,
      kind: artifacts.kind,
      contentType: artifacts.contentType,
      bytes: artifacts.bytes,
      createdAt: artifacts.createdAt,
    })
    .from(artifacts)
    .where(eq(artifacts.battleId, battleId))
    .orderBy(artifacts.kind, artifacts.side);
}

// ---- harnesses ---------------------------------------------------------------------------------

export async function getHarnessBySlug(db: ArenaDatabase, slug: string): Promise<Harness | null> {
  const [row] = await db.select().from(harnesses).where(eq(harnesses.slug, slug)).limit(1);
  return row ?? null;
}

export async function listHarnesses(
  db: ArenaDatabase,
  opts: { limit?: number; ownerUserId?: string } = {},
): Promise<Harness[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // The owner filter runs in SQL (index harnesses_owner_idx), so a caller listing one user's
  // harnesses is not limited to whatever fits in the most-recently-updated page of the catalog.
  const query = db.select().from(harnesses);
  const scoped = opts.ownerUserId ? query.where(eq(harnesses.ownerUserId, opts.ownerUserId)) : query;
  return scoped.orderBy(desc(harnesses.updatedAt), harnesses.slug).limit(limit);
}

/** How many recent decided battles the profile's derived numbers are computed over. */
export const PROFILE_BATTLE_WINDOW = 200;

const EFFICIENCY_PROFILE_KEYS = ['tokens_total', 'cost_usd', 'duration_ms'] as const;
type EfficiencyProfileKey = (typeof EFFICIENCY_PROFILE_KEYS)[number];

export interface HarnessCategoryPerformance {
  category: RatingCategory;
  /** decided public battles this harness fought in the category */
  battles: number;
  wins: number;
  losses: number;
  ties: number;
  /**
   * Share of `correctnessBattles` where this harness's side won or tied EVERY correctness gate that
   * actually ran (completion, tests, regressions, assertions, build). Null when no battle in the
   * category recorded a verdict breakdown, because a rate over nothing is not a rate.
   */
  correctnessRate: number | null;
  /** the denominator: decided battles whose verdict ran at least one correctness gate */
  correctnessBattles: number;
}

export interface HarnessEfficiencyRatio {
  metric: EfficiencyProfileKey;
  /** median of (this harness's value / the opponent's value) over battles where both reported it */
  median: number | null;
  n: number;
}

export type HarnessVersionPerformance = HarnessVersion & {
  battles: number;
  wins: number;
  losses: number;
  ties: number;
};

export interface HarnessProfile {
  harness: Harness;
  versions: HarnessVersionPerformance[];
  recentBattles: BattleListItem[];
  ratings: {
    category: string;
    pool: string;
    agentId: string;
    rating: number;
    deviation: number;
    battles: number;
    wins: number;
    losses: number;
    ties: number;
    provisional: boolean;
    peakRating: number;
    form: string;
    lastBattleAt: Date | null;
  }[];
  categoryPerformance: HarnessCategoryPerformance[];
  efficiencyProfile: HarnessEfficiencyRatio[];
  /** decided public battles the two derived sections above were computed over */
  analyzedBattles: number;
}

/** A side passed a battle when it won or tied every correctness gate that ran; null when none ran. */
function passedCorrectness(verdict: Verdict | null, side: 'a' | 'b'): boolean | null {
  const gates = (verdict?.breakdown ?? []).filter(
    (row) => row.factor !== 'efficiency' && row.result !== 'n/a',
  );
  if (gates.length === 0) return null;
  return gates.every((row) => row.result === side || row.result === 'tie');
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export async function getHarnessProfile(db: ArenaDatabase, slug: string): Promise<HarnessProfile | null> {
  const harness = await getHarnessBySlug(db, slug);
  if (!harness) return null;

  const versionRows = await db
    .select()
    .from(harnessVersions)
    .where(eq(harnessVersions.harnessId, harness.id))
    .orderBy(desc(harnessVersions.createdAt))
    .limit(20);

  const battleRows = await db
    .select(listSelection())
    .from(battles)
    .leftJoin(runA, and(eq(runA.battleId, battles.id), eq(runA.side, 'a')))
    .leftJoin(harnessA, eq(harnessA.id, runA.harnessId))
    .leftJoin(runB, and(eq(runB.battleId, battles.id), eq(runB.side, 'b')))
    .leftJoin(harnessB, eq(harnessB.id, runB.harnessId))
    .where(
      and(eq(battles.visibility, 'public'), or(eq(harnessA.id, harness.id), eq(harnessB.id, harness.id))),
    )
    .orderBy(desc(battles.createdAt))
    .limit(10);

  const ratingRows = await db
    .select({
      category: ratings.category,
      pool: ratings.pool,
      agentId: ratings.agentId,
      rating: ratings.rating,
      deviation: ratings.deviation,
      battles: ratings.battles,
      wins: ratings.wins,
      losses: ratings.losses,
      ties: ratings.ties,
      provisional: ratings.provisional,
      peakRating: ratings.peakRating,
      form: ratings.form,
      lastBattleAt: ratings.lastBattleAt,
    })
    .from(ratings)
    .where(eq(ratings.harnessId, harness.id))
    .orderBy(ratings.pool, ratings.category);

  // Decided public battles this harness fought, newest first and capped: everything derived below
  // (category performance, efficiency ratios) is computed over exactly this window and says so.
  const decided = await db
    .select({
      id: battles.id,
      category: battles.category,
      winner: battles.winner,
      aHarnessId: runA.harnessId,
      bHarnessId: runB.harnessId,
      verdict: evaluations.verdict,
    })
    .from(battles)
    .innerJoin(runA, and(eq(runA.battleId, battles.id), eq(runA.side, 'a')))
    .innerJoin(runB, and(eq(runB.battleId, battles.id), eq(runB.side, 'b')))
    .leftJoin(evaluations, eq(evaluations.battleId, battles.id))
    .where(
      and(
        eq(battles.visibility, 'public'),
        eq(battles.status, 'completed'),
        inArray(battles.winner, ['a', 'b', 'tie']),
        or(eq(runA.harnessId, harness.id), eq(runB.harnessId, harness.id)),
      ),
    )
    .orderBy(desc(battles.createdAt), desc(battles.id))
    .limit(PROFILE_BATTLE_WINDOW);

  const sideOf = new Map<string, 'a' | 'b'>();
  const byCategory = new Map<RatingCategory, HarnessCategoryPerformance>();
  for (const row of decided) {
    const side: 'a' | 'b' = row.aHarnessId === harness.id ? 'a' : 'b';
    sideOf.set(row.id, side);
    const passed = passedCorrectness(row.verdict ?? null, side);
    // Same accounting as the ratings: every battle counts towards `overall` and towards its own
    // category, so the `overall` row is the harness's whole record and a category can be compared
    // against it.
    for (const category of ratingCategoriesFor(row.category)) {
      const entry = byCategory.get(category) ?? {
        category,
        battles: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        correctnessRate: null,
        correctnessBattles: 0,
      };
      entry.battles += 1;
      if (row.winner === 'tie') entry.ties += 1;
      else if (row.winner === side) entry.wins += 1;
      else entry.losses += 1;
      if (passed !== null) {
        entry.correctnessBattles += 1;
        // correctnessRate accumulates successes here and is divided through below.
        entry.correctnessRate = (entry.correctnessRate ?? 0) + (passed ? 1 : 0);
      }
      byCategory.set(category, entry);
    }
  }
  const categoryPerformance = [...byCategory.values()]
    .map((entry) => ({
      ...entry,
      correctnessRate:
        entry.correctnessBattles === 0 ? null : (entry.correctnessRate ?? 0) / entry.correctnessBattles,
    }))
    .sort((a, b) => (a.category === 'overall' ? -1 : b.category === 'overall' ? 1 : b.battles - a.battles));

  const battleIds = [...sideOf.keys()];
  const ratios = new Map<EfficiencyProfileKey, number[]>(
    EFFICIENCY_PROFILE_KEYS.map((key) => [key, [] as number[]]),
  );
  if (battleIds.length > 0) {
    const metricRows = await db
      .select({ battleId: metrics.battleId, side: metrics.side, key: metrics.key, value: metrics.value })
      .from(metrics)
      .where(
        and(
          inArray(metrics.battleId, battleIds),
          inArray(metrics.key, [...EFFICIENCY_PROFILE_KEYS]),
          ne(metrics.status, 'unavailable'),
        ),
      );
    const seen = new Map<string, { a?: number; b?: number }>();
    for (const row of metricRows) {
      if (typeof row.value !== 'number' || !Number.isFinite(row.value)) continue;
      const slot = seen.get(`${row.battleId}|${row.key}`) ?? {};
      slot[row.side] = row.value;
      seen.set(`${row.battleId}|${row.key}`, slot);
    }
    for (const [compound, pair] of seen) {
      const [battleId, key] = compound.split('|') as [string, EfficiencyProfileKey];
      const side = sideOf.get(battleId);
      if (!side) continue;
      const mine = side === 'a' ? pair.a : pair.b;
      const theirs = side === 'a' ? pair.b : pair.a;
      if (mine === undefined || theirs === undefined || theirs <= 0) continue;
      ratios.get(key)?.push(mine / theirs);
    }
  }
  const efficiencyProfile: HarnessEfficiencyRatio[] = EFFICIENCY_PROFILE_KEYS.map((metric) => {
    const values = ratios.get(metric) ?? [];
    return { metric, median: median(values), n: values.length };
  });

  // Per-version record, from the audit trail: `overall` only, so a battle that also moved a category
  // rating is counted once.
  const versionOutcomes = await db
    .select({
      versionId: ratingEvents.harnessVersionId,
      outcome: ratingEvents.outcome,
      count: sql<number>`count(*)::int`,
    })
    .from(ratingEvents)
    .where(and(eq(ratingEvents.harnessId, harness.id), eq(ratingEvents.category, 'overall')))
    .groupBy(ratingEvents.harnessVersionId, ratingEvents.outcome);

  const versions: HarnessVersionPerformance[] = versionRows.map((version) => {
    const rows = versionOutcomes.filter((row) => row.versionId === version.id);
    const count = (outcome: 'win' | 'loss' | 'tie'): number =>
      rows.filter((row) => row.outcome === outcome).reduce((sum, row) => sum + Number(row.count), 0);
    const wins = count('win');
    const losses = count('loss');
    const ties = count('tie');
    return { ...version, battles: wins + losses + ties, wins, losses, ties };
  });

  return {
    harness,
    versions,
    recentBattles: battleRows.map(toListItem),
    ratings: ratingRows,
    categoryPerformance,
    efficiencyProfile,
    analyzedBattles: decided.length,
  };
}

export { applyBattleToRatings, getLeaderboard } from './ratings.js';
