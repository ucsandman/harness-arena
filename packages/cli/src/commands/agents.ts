import type { AdapterCapabilities, AgentAdapter, Detection } from '@harness-arena/adapters';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import type { Ui } from '../ui.js';

export interface AgentsFlags {
  json?: boolean;
}

export interface AgentRow {
  id: string;
  displayName: string;
  installed: boolean;
  version: string | null;
  auth: Detection['auth'];
  path: string | null;
  notes: string[];
  capabilities: AdapterCapabilities;
}

/** Telemetry the adapter can actually observe, in the order users ask about it. */
const SUMMARY_KEYS: ReadonlyArray<keyof AdapterCapabilities> = [
  'tokens',
  'cost',
  'turns',
  'toolCalls',
  'subagents',
];

export function capabilitySummary(capabilities: AdapterCapabilities): string {
  const observed: string[] = [];
  const missing: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = capabilities[key];
    if (value === 'observed' || value === 'derived') observed.push(String(key));
    else missing.push(String(key));
  }
  const parts: string[] = [];
  if (observed.length > 0) parts.push(observed.join('/') + ' reported');
  if (missing.length > 0) parts.push(missing.join('/') + ' n/a');
  return parts.join(', ');
}

export async function collectAgentRows(deps: CliDeps): Promise<AgentRow[]> {
  const registry = deps.createRegistry();
  const detections = await deps.detectAgents(registry, deps.env);
  const byId = new Map<string, Detection>(detections.map((d) => [d.id, d]));
  return registry.list().map((adapter: AgentAdapter) => {
    const detection = byId.get(adapter.id);
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      installed: detection?.installed === true,
      version: detection?.version ?? null,
      auth: detection?.auth ?? 'unknown',
      path: detection?.path ?? null,
      notes: detection?.notes ?? [],
      capabilities: adapter.capabilities(),
    };
  });
}

export function agentMark(ui: Ui, row: AgentRow): string {
  if (!row.installed) return ui.c.dim(ui.sym.no);
  if (row.auth === 'ok') return ui.c.green(ui.sym.ok);
  if (row.auth === 'missing') return ui.c.red(ui.sym.no);
  return ui.c.yellow(ui.sym.unknown);
}

/** `arena agents`: what is installed, what is signed in, and what each CLI can report. */
export async function agentsCommand(deps: CliDeps, flags: AgentsFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const rows = await collectAgentRows(deps);

  if (ui.json) {
    ui.emitJson({
      agents: rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        installed: row.installed,
        version: row.version,
        auth: row.auth,
        path: row.path,
        notes: row.notes,
        capabilities: row.capabilities,
      })),
    });
    return;
  }

  ui.line(ui.c.bold('Detected agents'));
  ui.table(
    rows.map((row) => [
      agentMark(ui, row) + ' ' + row.displayName,
      row.installed ? (row.version ?? 'installed') : 'not installed',
      'auth ' + row.auth,
      capabilitySummary(row.capabilities),
    ]),
  );
  const missing = rows.filter((row) => !row.installed && row.id !== 'fake');
  if (missing.length > 0) {
    ui.line();
    ui.line(
      ui.c.dim(
        'Not installed: ' +
          missing.map((row) => row.displayName).join(', ') +
          '. Install the CLI and sign in with your own subscription; Arena never handles credentials.',
      ),
    );
  }
  const notes = rows.flatMap((row) => row.notes.map((note) => row.displayName + ': ' + note));
  if (notes.length > 0) {
    ui.line();
    for (const note of notes.slice(0, 6)) ui.line(ui.c.dim('  ' + ui.sym.dot + ' ' + note));
  }
}
