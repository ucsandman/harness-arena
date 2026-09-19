import fs from 'node:fs';
import path from 'node:path';
import { createDemoSpec } from '@harness-arena/core';
import type { BattleRecord } from '@harness-arena/protocol';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import { resolveHome } from '../config.js';
import { parseSpec } from '../spec.js';
import { battleJson, executeBattle, finishBattle } from '../runner.js';
import { CliError } from '../errors.js';

export interface DemoFlags {
  json?: boolean;
  open?: boolean;
  export?: string;
  home?: string;
}

const HOME_PLACEHOLDER = '~/.harness-arena';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite every spelling of the local ARENA_HOME to `~/.harness-arena` so an exported demo is
 * identical on every machine: the native path, the forward-slash form, and the JSON-escaped form.
 */
export function rewriteHome(text: string, home: string, platform: string): string {
  const absolute = path.resolve(home);
  const variants = new Set([
    absolute,
    absolute.split(path.sep).join('/'),
    JSON.stringify(absolute).slice(1, -1),
  ]);
  let out = text;
  for (const variant of variants) {
    if (variant.length === 0) continue;
    const flags = platform === 'win32' ? 'gi' : 'g';
    out = out.replace(new RegExp(escapeRegExp(variant), flags), HOME_PLACEHOLDER);
  }
  return out;
}

async function exportBattle(
  deps: CliDeps,
  home: string,
  record: BattleRecord,
  dir: string,
): Promise<{ recordFile: string; eventsFile: string; events: number }> {
  const store = deps.createStateStore(home);
  const events = await store.readEvents(record.id);
  const target = path.resolve(deps.cwd(), dir);
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    throw new CliError('could not create the export directory ' + target + ': ' + (err as Error).message);
  }
  const recordFile = path.join(target, 'battle.json');
  const eventsFile = path.join(target, 'events.ndjson');
  fs.writeFileSync(
    recordFile,
    rewriteHome(JSON.stringify(record, null, 2) + '\n', home, deps.platform),
    'utf8',
  );
  fs.writeFileSync(
    eventsFile,
    rewriteHome(events.map((event) => JSON.stringify(event)).join('\n') + '\n', home, deps.platform),
    'utf8',
  );
  return { recordFile, eventsFile, events: events.length };
}

/** `arena demo`: two deterministic fake runs. No agent CLI, no network, no model spend. */
export async function demoCommand(deps: CliDeps, flags: DemoFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const spec = parseSpec(createDemoSpec(), 'the demo battle');

  if (!ui.json) {
    ui.line(ui.c.bold('Demo battle') + ' ' + ui.c.dim('(deterministic fixtures, no model spend)'));
  }

  const outcome = await executeBattle(deps, ui, {
    spec,
    home,
    trust: true,
    localOnly: true,
    open: flags.open === true,
    execute: (options) => deps.runDemoBattle(options),
  });

  let exported: { recordFile: string; eventsFile: string; events: number } | null = null;
  if (flags.export) {
    exported = await exportBattle(deps, home, outcome.record, flags.export);
  }

  if (ui.json) {
    const base = battleJson(outcome.record, outcome.reportPath, outcome.url) as Record<string, unknown>;
    ui.emitJson(exported ? { ...base, export: exported } : base);
    if (outcome.exitCode !== 0) {
      throw new CliError('the demo battle ' + outcome.record.status, outcome.exitCode);
    }
    return;
  }

  finishBattle(ui, outcome);
  if (exported) {
    ui.line();
    ui.success('exported ' + exported.events + ' events to ' + path.dirname(exported.recordFile));
  }
}
