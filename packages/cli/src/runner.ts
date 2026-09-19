import path from 'node:path';
import type { ArenaEvent, BattleRecord, BattleSpec, PrivacySettings, Side } from '@harness-arena/protocol';
import type { CreatedBattle, RunBattleOptions, Uploader } from '@harness-arena/core';
import type { HarnessExecution, ResolvedHarness } from '@harness-arena/core';
import type { CliDeps } from './deps.js';
import { createStatusView, createUiLogger, metricsTable } from './ui.js';
import type { Ui } from './ui.js';
import { getToken, resolveServerUrl } from './config.js';
import { CliError, EXIT } from './errors.js';

/**
 * The one place a battle is executed. `arena battle`, `arena run`, `arena demo` and
 * `arena regression` all come through here so the live output, the upload wiring, the exit codes and
 * the JSON shape are identical.
 */

export interface ExecuteBattleOptions {
  spec: BattleSpec;
  home: string;
  /** run under a battle id the server already created (`arena run --battle <id>`) */
  battleId?: string;
  /** approve harness install/prepare commands without asking */
  trust: boolean;
  localOnly: boolean;
  open: boolean;
  keepWorkspaces?: boolean;
  serverUrl?: string;
  /** how the battle is started; defaults to runBattle(spec, options). `arena demo` passes runDemoBattle. */
  execute?: (options: RunBattleOptions) => Promise<BattleRecord>;
  /** regression runs many battles: no live status lines, no per-battle printing */
  quiet?: boolean;
}

export interface BattleOutcome {
  record: BattleRecord;
  reportPath: string;
  url: string | null;
  trustDenied: boolean;
  exitCode: number;
  uploadedEvents: number;
}

/**
 * The engine pushes events and patches the record but never creates the battle on the server
 * (see openIssues). This wrapper creates it from the first record it sees and holds the event
 * batches until then, so nothing is lost and no request is sent to a battle that does not exist.
 *
 * `existing` is a battle the server already created (`arena run --battle <id>`): it is never posted
 * a second time, and every event, patch and artifact goes straight through under that id.
 */
export function createLazyUploader(
  base: Uploader,
  existing: CreatedBattle | null = null,
): {
  uploader: Uploader;
  created: () => CreatedBattle | null;
} {
  let created: CreatedBattle | null = existing;
  let attempted = existing !== null;
  const pending: ArenaEvent[][] = [];

  async function ensure(record: BattleRecord): Promise<void> {
    if (attempted) return;
    attempted = true;
    created = await base.createBattle(record);
  }

  async function drain(battleId: string): Promise<void> {
    if (created === null) {
      pending.length = 0;
      return;
    }
    while (pending.length > 0) {
      const batch = pending.shift() as ArenaEvent[];
      await base.pushEvents(battleId, batch);
    }
  }

  const uploader: Uploader = {
    createBattle: async (record) => {
      await ensure(record);
      return created;
    },
    pushEvents: async (battleId, events) => {
      if (created === null) {
        pending.push([...events]);
        return;
      }
      await base.pushEvents(battleId, events);
    },
    patchRecord: async (battleId, record) => {
      await ensure(record);
      await drain(battleId);
      if (created === null) return;
      await base.patchRecord(battleId, record);
    },
    uploadArtifact: async (battleId, side, kind, content) => {
      if (created === null) return;
      await base.uploadArtifact(battleId, side, kind, content);
    },
    flush: () => base.flush(),
    stats: () => base.stats(),
  };

  return { uploader, created: () => created };
}

/**
 * Links for a battle the server already created (`arena run --battle <id>`), in the shape the API
 * returns for a new one (apps/web/lib/links.ts), so the URL printed is that battle's own page.
 */
function existingBattleLinks(serverUrl: string, battleId: string): CreatedBattle {
  const base = serverUrl.replace(/\/+$/, '');
  return {
    id: battleId,
    url: base + '/battles/' + battleId,
    streamUrl: base + '/api/v1/battles/' + battleId + '/stream',
  };
}

/** The same default the engine uses, so a side is named identically everywhere. */
export function sideLabel(spec: BattleSpec, side: Side): string {
  const competitor = spec.competitors[side];
  return competitor.label ?? competitor.agent.id + ' + ' + competitor.harness.source;
}

function privacyOf(spec: BattleSpec, localOnly: boolean): PrivacySettings {
  return localOnly ? { ...spec.privacy, upload: 'none' } : spec.privacy;
}

export function verdictLine(record: BattleRecord, ui: Ui): string {
  const verdict = record.verdict;
  if (!verdict) return ui.c.yellow('No verdict: the battle did not reach evaluation.');
  const labels: Record<Side, string> = { a: record.runs.a.label, b: record.runs.b.label };
  const confidence = Math.round(verdict.confidence * 100) + '% confidence';
  if (verdict.winner === 'a' || verdict.winner === 'b') {
    return (
      ui.c.green(ui.sym.ok + ' Winner: ' + labels[verdict.winner]) +
      ' (' +
      confidence +
      ', ' +
      verdict.method +
      ')'
    );
  }
  if (verdict.winner === 'tie') return ui.c.yellow('Tie') + ' (' + confidence + ', ' + verdict.method + ')';
  return ui.c.yellow('Inconclusive') + ' (' + verdict.method + ')';
}

/** The JSON document `--json` prints. Stable shape: scripts and CI read it. */
export function battleJson(record: BattleRecord, reportPath: string, url: string | null): unknown {
  const side = (s: Side) => {
    const run = record.runs[s];
    return {
      label: run.label,
      status: run.status,
      agent: run.agent.id,
      agentVersion: run.agent.version,
      model: run.agent.model,
      harness: { name: run.harness.name, source: run.harness.source, commit: run.harness.commit },
      durationMs: run.durationMs,
      exitCode: run.exitCode,
      metrics: run.metrics,
      error: run.error,
    };
  };
  return {
    id: record.id,
    status: record.status,
    title: record.spec.title ?? record.task.title,
    demo: record.demo,
    verdict: record.verdict,
    insights: record.insights,
    runs: { a: side('a'), b: side('b') },
    reportPath,
    url,
    error: record.error,
    arenaVersion: record.arenaVersion,
  };
}

export function printBattleOutcome(ui: Ui, outcome: BattleOutcome): void {
  const record = outcome.record;
  ui.line();
  ui.line(verdictLine(record, ui));
  const table = metricsTable(record);
  ui.line();
  ui.table(table.rows, table.head);
  if (record.insights.length > 0) {
    ui.heading('Insights');
    for (const insight of record.insights.slice(0, 5)) ui.line('  ' + ui.sym.dot + ' ' + insight.text);
  }
  if (record.error) {
    ui.line();
    ui.warn(record.error);
  }
  ui.line();
  ui.detail('Report', outcome.reportPath, 8);
  if (outcome.url) ui.detail('Web', outcome.url, 8);
  ui.detail('Battle', record.id, 8);
}

export async function executeBattle(
  deps: CliDeps,
  ui: Ui,
  opts: ExecuteBattleOptions,
): Promise<BattleOutcome> {
  const store = deps.createStateStore(opts.home);
  const spec = opts.spec;
  const privacy = privacyOf(spec, opts.localOnly);
  const logger = createUiLogger(ui);

  let uploader: Uploader | null = null;
  let createdBattle: () => CreatedBattle | null = () => null;
  if (privacy.upload === 'none' && opts.battleId) {
    ui.warn(
      'this spec uploads nothing (privacy.upload is none), so battle ' +
        opts.battleId +
        ' stays pending on the server; results land only in ' +
        opts.home,
    );
  }
  if (privacy.upload !== 'none') {
    const token = await getToken(store);
    if (!token) {
      ui.warn('not logged in, so nothing is uploaded: run `arena login` or pass --local-only.');
    } else {
      const config = await store.getConfig();
      const serverUrl = resolveServerUrl(deps, config, opts.serverUrl);
      const lazy = createLazyUploader(
        deps.createUploader({ serverUrl, token, privacy, logger, fetchImpl: deps.fetchImpl }),
        opts.battleId ? existingBattleLinks(serverUrl, opts.battleId) : null,
      );
      uploader = lazy.uploader;
      createdBattle = lazy.created;
    }
  }

  const labels: Record<Side, string> = { a: sideLabel(spec, 'a'), b: sideLabel(spec, 'b') };
  const view = createStatusView(ui, labels, {
    tty: ui.tty && opts.quiet !== true,
    now: deps.now,
    write: (text) => deps.writeErr(text),
  });
  const live = opts.quiet !== true;

  let trustDenied = false;
  const trust = async (harness: ResolvedHarness, exec: HarnessExecution): Promise<boolean> => {
    if (opts.trust) {
      if (live) ui.status('trusting ' + harness.name + ': ' + exec.commands.join(' && '));
      return true;
    }
    if (!ui.tty || opts.quiet === true) {
      trustDenied = true;
      return false;
    }
    ui.line();
    ui.line(ui.c.bold('Harness ' + harness.name + ' wants to run commands on this machine:'));
    for (const command of exec.commands) ui.line('  $ ' + command);
    const approved = await deps.prompter.confirm({
      message: 'Run these commands?',
      initialValue: false,
    });
    if (approved !== true) trustDenied = true;
    return approved === true;
  };

  const execute = opts.execute ?? ((options: RunBattleOptions) => deps.runBattle(spec, options));
  const record = await execute({
    home: opts.home,
    logger,
    ...(opts.battleId ? { battleId: opts.battleId } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(uploader ? { uploader } : {}),
    ...(opts.keepWorkspaces ? { keepWorkspaces: true } : {}),
    onStatus: (status, detail) => {
      if (live) view.battle(status, detail);
    },
    onEvent: (event) => {
      if (live) view.observe(event);
    },
    trust,
  });
  view.stop();

  const created = createdBattle();
  const reportPath = store.paths(record.id).report;
  const exitCode = trustDenied
    ? EXIT.notTrusted
    : record.status === 'completed'
      ? EXIT.ok
      : EXIT.battleIncomplete;

  const outcome: BattleOutcome = {
    record,
    reportPath,
    url: created?.url ?? null,
    trustDenied,
    exitCode,
    uploadedEvents: uploader ? uploader.stats().events : 0,
  };

  if (opts.open) {
    const target = outcome.url ?? reportPath;
    try {
      await deps.openUrl(target);
    } catch {
      ui.warn('could not open ' + target + ' in a browser.');
    }
  }

  return outcome;
}

/** `arena run`/`arena battle` share this: print and turn the outcome into an exit code. */
export function finishBattle(ui: Ui, outcome: BattleOutcome): void {
  if (ui.json) {
    ui.emitJson(battleJson(outcome.record, outcome.reportPath, outcome.url));
  } else {
    printBattleOutcome(ui, outcome);
  }
  if (outcome.trustDenied) {
    throw new CliError(
      'the harness was not trusted, so the battle did not run. Re-run with --trust to allow its commands.',
      EXIT.notTrusted,
    );
  }
  if (outcome.exitCode !== EXIT.ok) {
    throw new CliError(
      'the battle ' +
        outcome.record.status +
        ': ' +
        (outcome.record.error ?? 'see the report for details') +
        ' (' +
        path.basename(outcome.reportPath) +
        ')',
      outcome.exitCode,
    );
  }
}
