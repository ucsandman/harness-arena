import type { CliDeps } from '../deps.js';
import { createUi, shortDate } from '../ui.js';
import { resolveHome } from '../config.js';
import { parsePositiveInt } from '../spec.js';

export interface ListFlags {
  limit?: string;
  json?: boolean;
  home?: string;
}

/** `arena list`: battles stored under ARENA_HOME, newest first. */
export async function listCommand(deps: CliDeps, flags: ListFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);
  const limit = flags.limit === undefined ? 20 : parsePositiveInt(flags.limit, '--limit');
  const battles = await store.listBattles({ limit });

  if (ui.json) {
    ui.emitJson({ home, count: battles.length, battles });
    return;
  }

  if (battles.length === 0) {
    ui.line('No battles in ' + home + ' yet. Run `arena demo` to make one.');
    return;
  }

  const rows = battles.map((battle) => [
    battle.id,
    battle.status,
    battle.winner === null
      ? '-'
      : battle.winner === 'a'
        ? battle.a.label
        : battle.winner === 'b'
          ? battle.b.label
          : battle.winner,
    shortDate(battle.createdAt),
    battle.demo ? battle.title + ' (demo)' : battle.title,
  ]);
  ui.table(rows, ['Id', 'Status', 'Winner', 'Created', 'Title']);
  ui.line();
  ui.line(ui.c.dim(String(battles.length) + ' battle(s) in ' + home));
}
