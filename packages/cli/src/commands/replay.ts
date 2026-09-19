import fs from 'node:fs';
import { buildReportBundle, renderReportHtml } from '@harness-arena/core';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import { resolveHome } from '../config.js';
import { CliError } from '../errors.js';
import { resolveBattleId } from './status.js';

export interface ReplayFlags {
  json?: boolean;
  open?: boolean;
  home?: string;
}

/** `arena replay <id>`: rebuild report.html from the stored record and events, then open it. */
export async function replayCommand(
  deps: CliDeps,
  id: string | undefined,
  flags: ReplayFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);
  const battleId = await resolveBattleId(store, home, id);

  const record = await store.loadRecord(battleId);
  if (!record) throw new CliError('no battle ' + battleId + ' under ' + home);
  const events = await store.readEvents(battleId);
  const reportPath = store.paths(battleId).report;

  const html = renderReportHtml(buildReportBundle(record, events, record.arenaVersion));
  fs.writeFileSync(reportPath, html, 'utf8');

  if (ui.json) {
    ui.emitJson({
      id: record.id,
      status: record.status,
      events: events.length,
      reportPath,
      bytes: Buffer.byteLength(html, 'utf8'),
      verdict: record.verdict,
      runs: {
        a: { label: record.runs.a.label, status: record.runs.a.status },
        b: { label: record.runs.b.label, status: record.runs.b.status },
      },
    });
  } else {
    ui.success('rebuilt the report from ' + String(events.length) + ' events');
    ui.detail('Report', reportPath, 8);
  }

  // The report is the point of a replay, so it opens by default; --no-open and --json keep it closed.
  if (flags.open !== false && !ui.json) {
    try {
      await deps.openUrl(reportPath);
    } catch {
      ui.warn('could not open ' + reportPath + ' in a browser.');
    }
  }
}

/** `arena open <id>`: open a report that already exists. */
export async function openCommand(
  deps: CliDeps,
  id: string | undefined,
  flags: { home?: string; json?: boolean },
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);
  const battleId = await resolveBattleId(store, home, id);
  const reportPath = store.paths(battleId).report;

  if (!fs.existsSync(reportPath)) {
    throw new CliError('no report at ' + reportPath + '. Run `arena replay ' + battleId + '` to rebuild it.');
  }
  if (ui.json) ui.emitJson({ id: battleId, reportPath });
  else ui.line('Opening ' + reportPath);
  await deps.openUrl(reportPath);
}
