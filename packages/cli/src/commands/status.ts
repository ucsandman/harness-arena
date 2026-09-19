import type { Side } from '@harness-arena/protocol';
import type { StateStore } from '@harness-arena/core';
import type { CliDeps } from '../deps.js';
import { createUi, shortDate } from '../ui.js';
import type { Ui } from '../ui.js';
import { resolveHome } from '../config.js';
import { CliError } from '../errors.js';

export interface StatusFlags {
  json?: boolean;
  watch?: boolean;
  home?: string;
}

const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);
const WATCH_INTERVAL_MS = 500;

/** The newest battle, or the one the user named. */
export async function resolveBattleId(store: StateStore, home: string, id?: string): Promise<string> {
  if (id && id.trim().length > 0) return id.trim();
  const latest = await store.listBattles({ limit: 1 });
  const first = latest[0];
  if (!first) throw new CliError('no battles in ' + home + ' yet. Run `arena demo` to make one.');
  return first.id;
}

interface TailLine {
  seq: number;
  ts: string;
  side: Side | null;
  type: string;
}

/**
 * Tails the event log until the battle reaches a terminal status. In `--json` mode the lines are
 * collected instead of printed: `emitJson` is called once per command, so the events ride along in
 * the single status document the caller parses.
 */
async function tail(deps: CliDeps, ui: Ui, store: StateStore, battleId: string): Promise<TailLine[]> {
  const collected: TailLine[] = [];
  let afterSeq = 0;
  for (;;) {
    const events = await store.readEvents(battleId, { afterSeq });
    for (const event of events) {
      afterSeq = Math.max(afterSeq, event.seq);
      const line: TailLine = { seq: event.seq, ts: event.ts, side: event.side, type: event.type };
      if (ui.json) collected.push(line);
      else ui.line(String(event.seq).padStart(5) + '  ' + (event.side ?? '-') + '  ' + event.type);
    }
    const record = await store.loadRecord(battleId);
    if (record && TERMINAL_STATUS.has(record.status)) return collected;
    if (deps.signal?.aborted) return collected;
    await deps.sleep(WATCH_INTERVAL_MS);
  }
}

/** `arena status [id]`: one battle's state, optionally tailing its event log until it finishes. */
export async function statusCommand(
  deps: CliDeps,
  id: string | undefined,
  flags: StatusFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);
  const battleId = await resolveBattleId(store, home, id);

  let record = await store.loadRecord(battleId);
  if (!record) throw new CliError('no battle ' + battleId + ' under ' + home);

  let watched: TailLine[] | null = null;
  if (flags.watch === true) {
    watched = await tail(deps, ui, store, battleId);
    record = (await store.loadRecord(battleId)) ?? record;
  }

  if (ui.json) {
    ui.emitJson({
      id: record.id,
      status: record.status,
      title: record.spec.title ?? record.task.title,
      verdict: record.verdict,
      runs: {
        a: { label: record.runs.a.label, status: record.runs.a.status },
        b: { label: record.runs.b.label, status: record.runs.b.status },
      },
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      error: record.error,
      ...(watched ? { events: watched } : {}),
    });
    return;
  }

  ui.line(ui.c.bold(record.spec.title ?? record.task.title));
  ui.detail('Battle', record.id);
  ui.detail('Status', record.status + (record.demo ? ' (demo)' : ''));
  ui.detail('Created', shortDate(record.createdAt));
  ui.detail(record.runs.a.label, record.runs.a.status);
  ui.detail(record.runs.b.label, record.runs.b.status);
  if (record.verdict) {
    const winner =
      record.verdict.winner === 'a'
        ? record.runs.a.label
        : record.verdict.winner === 'b'
          ? record.runs.b.label
          : record.verdict.winner;
    ui.detail('Verdict', winner + ' (' + Math.round(record.verdict.confidence * 100) + '%)');
  }
  if (record.error) ui.warn(record.error);
}
