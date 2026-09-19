import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { LOCK_STALE_MS, gitVersion, removeWorktree } from '@harness-arena/core';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import { resolveHome } from '../config.js';
import { collectAgentRows } from './agents.js';

export interface DoctorFlags {
  fix?: boolean;
  json?: boolean;
  home?: string;
}

const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);
const MAX_WALK_ENTRIES = 200_000;

export interface OrphanWorkspace {
  battleId: string;
  status: string;
  dir: string;
  /** null when the battle ran on an empty repository and has no mirror to prune */
  mirror: string | null;
}

export interface StaleLock {
  battleId: string;
  file: string;
  pid: number;
  ageMs: number | null;
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

/** Bytes under a directory. Bounded: a pathological tree reports what it managed to count. */
export function directorySize(dir: string): { bytes: number; entries: number; complete: boolean } {
  let bytes = 0;
  let entries = 0;
  const queue: string[] = [dir];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (entries >= MAX_WALK_ENTRIES) return { bytes, entries, complete: false };
      const full = path.join(current, item.name);
      entries += 1;
      if (item.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!item.isFile()) continue;
      try {
        bytes += fs.statSync(full).size;
      } catch {
        // a file that vanished between readdir and stat contributes nothing
      }
    }
  }
  return { bytes, entries, complete: true };
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[unit];
}

function writable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.arena-write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function findOrphans(
  deps: CliDeps,
  home: string,
): Promise<{ orphans: OrphanWorkspace[]; locks: StaleLock[]; scanned: number }> {
  const store = deps.createStateStore(home);
  const battlesDir = path.join(home, 'battles');
  let ids: string[];
  try {
    ids = fs.readdirSync(battlesDir).filter((id) => fs.statSync(path.join(battlesDir, id)).isDirectory());
  } catch {
    return { orphans: [], locks: [], scanned: 0 };
  }

  const orphans: OrphanWorkspace[] = [];
  const locks: StaleLock[] = [];
  for (const id of ids) {
    const paths = store.paths(id);
    let lockPid = 0;
    let lockAge: number | null = null;
    let lockExists = false;
    try {
      const raw = fs.readFileSync(paths.lock, 'utf8');
      lockExists = true;
      const parsed = JSON.parse(raw) as { pid?: number; startedAt?: string };
      lockPid = typeof parsed.pid === 'number' ? parsed.pid : 0;
      lockAge = parsed.startedAt ? Date.now() - Date.parse(parsed.startedAt) : null;
    } catch {
      if (fs.existsSync(paths.lock)) lockExists = true;
    }
    const lockActive = lockExists && pidAlive(lockPid) && (lockAge === null || lockAge < LOCK_STALE_MS);
    if (lockExists && !lockActive) {
      locks.push({ battleId: id, file: paths.lock, pid: lockPid, ageMs: lockAge });
    }

    const record = await store.loadRecord(id);
    const status = record?.status ?? 'unknown';
    if (record && TERMINAL_STATUS.has(status)) continue;
    if (lockActive) continue;
    for (const side of ['a', 'b'] as const) {
      const dir = paths.workspaces[side];
      if (!fs.existsSync(dir)) continue;
      const source = record?.repository.source ?? null;
      const mirror = source && record?.repository.kind !== 'empty' ? store.mirrorPath(source) : null;
      orphans.push({ battleId: id, status, dir, mirror });
    }
  }
  return { orphans, locks, scanned: ids.length };
}

/** `arena doctor`: is this machine ready, and is anything left over from a crash? */
export async function doctorCommand(deps: CliDeps, flags: DoctorFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const homeWritable = writable(home);
  const git = await gitVersion({ home });
  const agents = await collectAgentRows(deps);
  const { orphans, locks, scanned } = await findOrphans(deps, home);
  const size = directorySize(home);

  const removed: string[] = [];
  const failures: string[] = [];
  const recovered: string[] = [];
  if (flags.fix === true) {
    // A battle whose process died mid-run stays "running" forever otherwise; nothing is alive to
    // finish it, so the record is closed as cancelled with the reason spelled out.
    const store = deps.createStateStore(home);
    for (const id of new Set([...orphans.map((o) => o.battleId), ...locks.map((l) => l.battleId)])) {
      try {
        const record = await store.loadRecord(id);
        if (!record || TERMINAL_STATUS.has(record.status)) continue;
        const endedAt = new Date(deps.now()).toISOString();
        record.status = 'cancelled';
        record.error = 'the arena process ended before this battle completed; closed by arena doctor --fix';
        record.completedAt = endedAt;
        for (const side of ['a', 'b'] as const) {
          const run = record.runs[side];
          if (run.status === 'pending' || run.status === 'preparing' || run.status === 'running') {
            run.status = 'interrupted';
            run.completedAt = endedAt;
          }
        }
        await store.saveRecord(record);
        recovered.push(id);
      } catch (err) {
        failures.push(id + ': ' + (err as Error).message);
      }
    }
    for (const orphan of orphans) {
      try {
        if (orphan.mirror && fs.existsSync(orphan.mirror)) {
          await removeWorktree({ mirror: orphan.mirror, dest: orphan.dir, home });
        } else {
          fs.rmSync(orphan.dir, { recursive: true, force: true });
        }
        removed.push(orphan.dir);
      } catch (err) {
        failures.push(orphan.dir + ': ' + (err as Error).message);
      }
    }
    for (const lock of locks) {
      try {
        fs.rmSync(lock.file, { force: true });
        removed.push(lock.file);
      } catch (err) {
        failures.push(lock.file + ': ' + (err as Error).message);
      }
    }
  }

  const installed = agents.filter((agent) => agent.installed && agent.id !== 'fake');
  const ok = homeWritable && git !== null && failures.length === 0;

  if (ui.json) {
    ui.emitJson({
      ok,
      node: process.version,
      git,
      home,
      homeWritable,
      homeBytes: size.bytes,
      homeSizeComplete: size.complete,
      agents: agents.map((agent) => ({
        id: agent.id,
        installed: agent.installed,
        version: agent.version,
        auth: agent.auth,
      })),
      battlesScanned: scanned,
      orphanedWorkspaces: orphans,
      staleLocks: locks,
      fixed: flags.fix === true ? { removed, recovered, failures } : null,
    });
    if (failures.length > 0) ui.warn(String(failures.length) + ' item(s) could not be removed.');
    return;
  }

  ui.line(ui.c.bold('arena doctor'));
  ui.detail('Node', process.version);
  ui.detail('git', git ?? ui.c.red('not found on PATH'));
  ui.detail('ARENA_HOME', home + (homeWritable ? '' : ui.c.red(' (not writable)')));
  ui.detail('Home size', humanBytes(size.bytes) + (size.complete ? '' : ' (partial count)'));
  ui.detail(
    'Agents',
    installed.length === 0
      ? 'none installed (only the deterministic fake adapter is available)'
      : installed.map((agent) => agent.id + ' ' + (agent.version ?? '?')).join(', '),
  );

  ui.line();
  if (orphans.length === 0) {
    ui.success('no orphaned battle workspaces (scanned ' + String(scanned) + ' battle directories)');
  } else {
    ui.warn(String(orphans.length) + ' orphaned battle workspace(s):');
    for (const orphan of orphans.slice(0, 10))
      ui.line('  ' + orphan.battleId + '  ' + orphan.status + '  ' + orphan.dir);
  }
  if (locks.length > 0) {
    ui.warn(String(locks.length) + ' stale lock(s):');
    for (const lock of locks.slice(0, 10)) ui.line('  ' + lock.battleId + '  pid ' + String(lock.pid));
  }

  if (flags.fix === true) {
    ui.line();
    ui.success('removed ' + String(removed.length) + ' item(s)');
    for (const id of recovered) ui.line('  closed ' + id + ' as cancelled (its process had ended)');
    for (const failure of failures) ui.warn(failure);
  } else if (orphans.length > 0 || locks.length > 0) {
    ui.line();
    ui.line(ui.c.dim('Run `arena doctor --fix` to remove them. Nothing outside ARENA_HOME is touched.'));
  }
}
