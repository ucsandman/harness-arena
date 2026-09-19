import fs from 'node:fs';
import path from 'node:path';
import type { CliDeps } from '../deps.js';
import { createUi, shortDate } from '../ui.js';
import { resolveHome } from '../config.js';
import { CancelledError, CliError } from '../errors.js';
import { humanBytes, directorySize } from './doctor.js';

export interface CleanFlags {
  olderThan?: string;
  yes?: boolean;
  json?: boolean;
  home?: string;
}

const DEFAULT_DAYS = 30;
const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);

export interface CleanCandidate {
  id: string;
  status: string;
  createdAt: string;
  dir: string;
  bytes: number;
}

/** `arena clean`: delete finished battle directories older than N days. Only inside ARENA_HOME. */
export async function cleanCommand(deps: CliDeps, flags: CleanFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const days = flags.olderThan === undefined ? DEFAULT_DAYS : Number(flags.olderThan);
  if (!Number.isFinite(days) || days < 0) throw new CliError('--older-than must be a number of days');
  const cutoff = deps.now() - days * 24 * 3600_000;

  const store = deps.createStateStore(home);
  const battles = await store.listBattles();
  const candidates: CleanCandidate[] = [];
  for (const battle of battles) {
    if (!TERMINAL_STATUS.has(battle.status)) continue;
    const created = Date.parse(battle.createdAt);
    if (!Number.isFinite(created) || created > cutoff) continue;
    const dir = store.paths(battle.id).dir;
    if (!fs.existsSync(dir)) continue;
    candidates.push({
      id: battle.id,
      status: battle.status,
      createdAt: battle.createdAt,
      dir,
      bytes: directorySize(dir).bytes,
    });
  }

  const total = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);

  if (candidates.length === 0) {
    if (ui.json) ui.emitJson({ home, scanned: battles.length, removed: [], bytes: 0 });
    else
      ui.line(
        'Nothing to clean: ' +
          String(battles.length) +
          ' battle(s) scanned, none finished before ' +
          String(days) +
          ' day(s) ago.',
      );
    return;
  }

  if (!ui.json) {
    ui.line(ui.c.bold('Battle directories to remove'));
    for (const candidate of candidates.slice(0, 20)) {
      ui.line(
        '  ' +
          candidate.id +
          '  ' +
          candidate.status +
          '  ' +
          shortDate(candidate.createdAt) +
          '  ' +
          humanBytes(candidate.bytes),
      );
    }
    if (candidates.length > 20) ui.line(ui.c.dim('  ... and ' + String(candidates.length - 20) + ' more'));
    ui.line();
    ui.line('Total: ' + String(candidates.length) + ' battle(s), ' + humanBytes(total));
  }

  if (flags.yes !== true) {
    if (!ui.tty) {
      throw new CliError(
        'refusing to delete without confirmation: re-run `arena clean --yes` (or run it in a terminal).',
      );
    }
    const approved = await deps.prompter.confirm({
      message: 'Delete ' + String(candidates.length) + ' battle directory(ies)?',
      initialValue: false,
    });
    if (approved !== true) throw new CancelledError('Nothing was deleted.');
  }

  const removed: string[] = [];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      // Belt and braces: never delete anything that is not inside <home>/battles.
      const battlesRoot = path.join(home, 'battles');
      if (!path.resolve(candidate.dir).startsWith(path.resolve(battlesRoot))) continue;
      await store.removeBattle(candidate.id);
      removed.push(candidate.id);
    } catch (err) {
      failures.push(candidate.id + ': ' + (err as Error).message);
    }
  }

  if (ui.json) {
    ui.emitJson({ home, scanned: battles.length, removed, failures, bytes: total });
    return;
  }
  ui.success('removed ' + String(removed.length) + ' battle directory(ies), freed ' + humanBytes(total));
  for (const failure of failures) ui.warn(failure);
}
