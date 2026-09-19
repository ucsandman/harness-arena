import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_FEATURE_LABELS } from '@harness-arena/protocol';
import type { BattleListItem, HarnessInspection } from '@harness-arena/protocol';
import { loadManifestFromDir, sourceCacheKey, parseHarnessSource } from '@harness-arena/harness';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import type { Ui } from '../ui.js';
import { resolveHome } from '../config.js';
import { resolveHarnessForCli } from '../harness.js';
import { CliError } from '../errors.js';

export interface InspectFlags {
  json?: boolean;
  ref?: string;
  agent?: string;
  home?: string;
}

const FRAMEWORK_LABEL: Record<HarnessInspection['framework'], string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  opencode: 'OpenCode',
  multi: 'multi-agent',
  unknown: 'unrecognized',
};

/** Features worth calling out when they are absent, because harness authors ask about them. */
const NOTABLE_ABSENT = [
  'claude_hooks',
  'claude_skills',
  'claude_subagents',
  'mcp',
  'arena_manifest',
] as const;

function featureCount(feature: HarnessInspection['features'][number]): string {
  if (typeof feature.count === 'number') return String(feature.count);
  return String(feature.paths.length);
}

export function printInspection(ui: Ui, inspection: HarnessInspection, label: string): void {
  ui.line();
  ui.line(
    ui.c.bold('Detected ' + FRAMEWORK_LABEL[inspection.framework] + ' harness') + '  ' + ui.c.dim(label),
  );
  if (inspection.commit) ui.detail('Commit', inspection.commit.slice(0, 12));
  if (inspection.agents.length > 0) ui.detail('Agents', inspection.agents.join(', '));
  ui.detail('Files scanned', String(inspection.fileCount) + (inspection.truncated ? ' (truncated)' : ''));

  const detected = inspection.features.filter((feature) => feature.detected);
  ui.line();
  if (detected.length === 0) {
    ui.line('  ' + ui.c.dim(ui.sym.no + ' no harness files detected'));
  }
  for (const feature of detected) {
    const count = featureCount(feature);
    const note = feature.note ? '  ' + ui.c.dim(feature.note) : '';
    ui.line(
      '  ' +
        ui.c.green(ui.sym.ok) +
        ' ' +
        feature.label.padEnd(18) +
        (count === '0' ? '' : count + (Number(count) === 1 ? ' file' : ' files')) +
        note,
    );
  }
  const absent = NOTABLE_ABSENT.filter((id) => !detected.some((feature) => feature.id === id)).map(
    (id) => HARNESS_FEATURE_LABELS[id],
  );
  for (const label2 of absent) {
    ui.line('  ' + ui.c.dim(ui.sym.no + ' ' + label2.padEnd(18) + 'none'));
  }

  const manifest = inspection.manifest;
  ui.line();
  if (manifest.found && manifest.valid) {
    ui.line('  ' + ui.c.green(ui.sym.ok) + ' ' + (manifest.path ?? 'arena.yaml') + ' is valid');
  } else if (manifest.found) {
    ui.line('  ' + ui.c.red(ui.sym.no) + ' ' + (manifest.path ?? 'arena.yaml') + ' is invalid');
    for (const error of manifest.errors.slice(0, 5)) ui.line('      ' + ui.c.red(error));
  } else {
    ui.line('  ' + ui.c.dim(ui.sym.dot + ' no arena.yaml: the files above are auto-detected'));
  }

  ui.line();
  if (inspection.install.commands.length === 0) {
    ui.line('  ' + ui.c.dim('No commands would run on your machine.'));
  } else {
    ui.line('  ' + ui.c.bold('Commands that WOULD run on your machine (only with --trust):'));
    for (const command of inspection.install.commands) ui.line('      $ ' + command);
  }
  if (inspection.applyFiles.length > 0) {
    ui.line('  ' + ui.c.dim('Files copied into the workspace: ' + inspection.applyFiles.join(', ')));
  }

  ui.line();
  const status = inspection.compatibility.status;
  ui.detail('Compatibility', status);
  for (const reason of inspection.compatibility.reasons)
    ui.line('      ' + ui.c.dim(ui.sym.dot + ' ' + reason));
  ui.line();
  if (status === 'ready') ui.line(ui.c.green(ui.sym.ok + ' Ready to battle'));
  else if (status === 'incompatible')
    ui.line(ui.c.red(ui.sym.no + ' Needs attention: this harness cannot battle as it is'));
  else ui.line(ui.c.yellow('! Needs attention: ' + status));
}

/** `arena harnesses inspect <url|path>`: the compatibility report, without executing anything. */
export async function harnessInspectCommand(
  deps: CliDeps,
  source: string,
  flags: InspectFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const resolved = await resolveHarnessForCli(deps, source, {
    home,
    agentId: flags.agent ?? 'claude-code',
    mode: 'inspect',
    ...(flags.ref ? { ref: flags.ref } : {}),
  });

  if (ui.json) {
    ui.emitJson({
      name: resolved.name,
      kind: resolved.kind,
      source,
      commit: resolved.commit,
      manifest: resolved.manifest,
      inspection: resolved.inspection,
    });
    return;
  }
  printInspection(ui, resolved.inspection, resolved.name);
}

export interface CachedHarness {
  key: string;
  dir: string;
  name: string | null;
  source: string | null;
  commit: string | null;
}

/**
 * Harnesses checked out under ARENA_HOME/harnesses. The directory name is a hash of the source, so
 * the readable source and commit come from the battle records that used it, and the name from
 * arena.yaml when the checkout has one.
 */
export async function readCachedHarnesses(deps: CliDeps, home: string): Promise<CachedHarness[]> {
  const root = path.join(home, 'harnesses');
  let entries: string[];
  try {
    entries = fs.readdirSync(root).filter((entry) => fs.statSync(path.join(root, entry)).isDirectory());
  } catch {
    return [];
  }

  const store = deps.createStateStore(home);
  const battles: BattleListItem[] = await store.listBattles({ limit: 200 });
  const byKey = new Map<string, { source: string; commit: string | null; name: string }>();
  for (const battle of battles) {
    const record = await store.loadRecord(battle.id);
    if (!record) continue;
    for (const side of ['a', 'b'] as const) {
      const harness = record.runs[side].harness;
      if (harness.kind === 'vanilla') continue;
      try {
        const key = sourceCacheKey(parseHarnessSource(harness.source));
        if (!byKey.has(key)) {
          byKey.set(key, { source: harness.source, commit: harness.commit, name: harness.name });
        }
      } catch {
        // a source the current parser rejects: the directory still shows up with an unknown source
      }
    }
  }

  const out: CachedHarness[] = [];
  for (const key of entries) {
    const dir = path.join(root, key);
    const known = byKey.get(key);
    const manifest = await loadManifestFromDir(dir).catch(() => null);
    const manifestName = manifest && manifest.result.ok ? manifest.result.manifest.name : null;
    out.push({
      key,
      dir,
      name: manifestName ?? known?.name ?? null,
      source: known?.source ?? null,
      commit: known?.commit ?? null,
    });
  }
  return out.sort((x, y) => (x.name ?? x.key).localeCompare(y.name ?? y.key));
}

/** `arena harnesses list`: what is already checked out locally. */
export async function harnessListCommand(
  deps: CliDeps,
  flags: { json?: boolean; home?: string },
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const harnesses = await readCachedHarnesses(deps, home);

  if (ui.json) {
    ui.emitJson({ home, count: harnesses.length, harnesses });
    return;
  }
  if (harnesses.length === 0) {
    ui.line('No harnesses cached under ' + path.join(home, 'harnesses') + '.');
    return;
  }
  ui.table(
    harnesses.map((harness) => [
      harness.name ?? harness.key.slice(0, 12),
      harness.source ?? ui.c.dim('unknown source'),
      harness.commit ? harness.commit.slice(0, 12) : 'n/a',
    ]),
    ['Name', 'Source', 'Commit'],
  );
}

/** Used by the welcome screen: harness configuration present in the working directory. */
export async function inspectWorkingDirectory(deps: CliDeps, dir: string): Promise<HarnessInspection | null> {
  if (!fs.existsSync(dir)) throw new CliError('no such directory: ' + dir);
  const resolved = await resolveHarnessForCli(deps, dir, {
    home: resolveHome(deps),
    agentId: 'claude-code',
  });
  return resolved.inspection;
}
