import path from 'node:path';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  experimentRecordPath,
  experimentsDir,
  expandBenchmark,
  listExperimentRunRecords,
  loadBenchmarkPack,
  loadExperimentRunRecord,
  newExperimentId,
  runBattle,
  saveExperimentRunRecord,
} from '@harness-arena/core';
import type { ExperimentBattleRef, ExperimentRunRecordInput, LoadedBenchmarkPack } from '@harness-arena/core';
import type { BattleSpecInput, CompetitorSpec, ExperimentKind } from '@harness-arena/protocol';
import type { ArenaContext } from '../context.js';
import { errorResult, errorText, jsonResult } from '../result.js';

/**
 * Experiments: control vs treatment over a benchmark pack, run locally one battle at a time. The
 * comparison summary (win rates, correctness deltas, evidence strength) is computed by the CLI from the
 * saved local record, not here: this file only runs the battles and persists what happened.
 */

interface ExperimentSide {
  source: string;
  commit?: string;
}

/**
 * "source" or "source@<commit>" where commit is 7-40 lowercase hex chars (harnessRefSchema's own
 * shape). Anything else, including scp-style git URLs like `git@host:owner/repo.git`, is left whole:
 * a host or path segment is never all-hex, so the regex only matches an actual commit suffix.
 */
function splitSourceCommit(input: string): ExperimentSide {
  const at = input.lastIndexOf('@');
  if (at <= 0) return { source: input };
  const commit = input.slice(at + 1);
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return { source: input };
  return { source: input.slice(0, at), commit };
}

function harnessRefOf(side: ExperimentSide): { source: string; commit?: string; trusted: false } {
  return side.commit === undefined
    ? { source: side.source, trusted: false }
    : { source: side.source, commit: side.commit, trusted: false };
}

interface RunExperimentArgs {
  kind: ExperimentKind;
  control: ExperimentSide;
  treatment: ExperimentSide;
  benchmarkFile: string;
  taskId?: string;
  agent: string;
  trials?: number;
  title?: string;
  trust: boolean;
  waitMs: number;
}

async function runExperimentCore(ctx: ArenaContext, args: RunExperimentArgs): Promise<CallToolResult> {
  if (ctx.runner.busy) {
    return errorResult(
      'battle ' +
        (ctx.runner.runningId ?? 'unknown') +
        ' is already running in this server; one battle runs at a time. Poll it with arena_get_battle ' +
        'and start the next one when it is done.',
    );
  }

  const file = path.resolve(args.benchmarkFile);
  let loaded: LoadedBenchmarkPack;
  try {
    loaded = await loadBenchmarkPack(file);
  } catch (err) {
    return errorResult('could not load the benchmark pack: ' + errorText(err));
  }

  const controlCompetitor: CompetitorSpec = {
    agent: { id: args.agent },
    harness: harnessRefOf(args.control),
  };
  const treatmentCompetitor: CompetitorSpec = {
    agent: { id: args.agent },
    harness: harnessRefOf(args.treatment),
  };

  let specs: BattleSpecInput[];
  try {
    specs = expandBenchmark(loaded.pack, loaded.versionId, {
      a: controlCompetitor,
      b: treatmentCompetitor,
      trials: args.trials,
      taskId: args.taskId,
      privacy: { upload: 'none', exclude: [], redact: true },
    });
  } catch (err) {
    return errorResult('could not expand ' + file + ': ' + errorText(err));
  }

  const run = ctx.deps.runBattle ?? runBattle;
  const battles: ExperimentBattleRef[] = [];

  for (const spec of specs) {
    if (ctx.runner.busy) {
      return errorResult(
        'battle ' +
          (ctx.runner.runningId ?? 'unknown') +
          ' is already running in this server; one battle runs at a time.',
      );
    }

    const outcome = await ctx.runner.start({
      trusted: args.trust,
      waitMs: args.waitMs,
      run: (hooks) =>
        run(spec, {
          home: ctx.home,
          registry: ctx.registry,
          logger: ctx.logger,
          signal: ctx.signal,
          onEvent: hooks.onEvent,
          onStatus: hooks.onStatus,
          trust: async (harness, exec) => {
            if (!args.trust) {
              ctx.logger.warn('refused harness commands: trust was not granted for this call', {
                harness: harness.name,
                commands: exec.commands.length,
              });
              return false;
            }
            ctx.logger.info('harness commands approved by the caller', {
              harness: harness.name,
              commands: exec.commands.length,
            });
            return true;
          },
        }),
    });
    await ctx.runner.idle();

    if (outcome.kind === 'busy' || outcome.kind === 'failed') {
      const message =
        outcome.kind === 'busy'
          ? 'battle ' +
            (outcome.runningId ?? 'unknown') +
            ' is already running in this server; one battle runs at a time.'
          : outcome.message;
      return errorResult(
        'the experiment stopped after ' +
          battles.length +
          ' of ' +
          specs.length +
          ' battle(s): ' +
          message +
          '. Nothing was saved.',
      );
    }

    const handle = outcome.handle;
    const record = outcome.finished ? await ctx.store.loadRecord(handle.id).catch(() => null) : null;
    const status = record?.status ?? handle.status;
    battles.push({
      battleId: handle.id,
      treatmentSide: 'b',
      taskId: spec.benchmark?.taskId ?? null,
      trial: spec.benchmark?.trial ?? 1,
      status,
      winner: record?.verdict?.winner ?? null,
      uploaded: false,
      url: null,
    });
  }

  const now = new Date().toISOString();
  const input: ExperimentRunRecordInput = {
    version: 1,
    id: newExperimentId(),
    title: args.title ?? args.kind + ': ' + args.control.source + ' vs ' + args.treatment.source,
    kind: args.kind,
    status: 'completed',
    control: { harness: harnessRefOf(args.control) },
    treatment: { harness: harnessRefOf(args.treatment) },
    changedComponent: null,
    agent: { id: args.agent },
    benchmark: {
      slug: loaded.pack.slug,
      versionId: loaded.versionId,
      version: loaded.pack.version,
      name: loaded.pack.name,
    },
    specDir: null,
    trials: args.trials ?? 1,
    battles,
    summary: null,
    server: null,
    createdAt: now,
    completedAt: now,
  };

  const savedFile = await saveExperimentRunRecord(ctx.home, input);
  const saved = await loadExperimentRunRecord(ctx.home, input.id);

  const summary =
    battles.length +
    ' battle(s) run for ' +
    args.kind +
    ' experiment ' +
    input.id +
    ', saved to ' +
    savedFile +
    '. Run "arena experiment show ' +
    input.id +
    '" to compute the comparison summary.';

  return jsonResult(summary, {
    id: input.id,
    file: savedFile,
    battles,
    record: saved,
    summaryNote: 'arena experiment show ' + input.id + ' computes it',
  });
}

const RUN_EXPERIMENT_DESCRIPTION = [
  'Runs an experiment: a control harness against a treatment harness over every task (or one, with',
  'taskId) of a benchmark pack, one battle at a time, control as side a and treatment as side b. kind',
  'labels why they differ: regression (control is an earlier commit of the same harness), ablation',
  '(the same harness with one component removed) or comparison (two unrelated harnesses); this call',
  'does not enforce which, it only records the label. control and treatment are harness sources,',
  'either a bare source ("vanilla", a GitHub URL, a local path) or "source@commit" pinning a 7-40 hex',
  'char commit. benchmark is the path to a pack file; agent (default "fake") runs on both sides; trials',
  "overrides every task's own trial count. One battle runs per server process: a call is refused,",
  'naming the battle already running, when this server is busy, and the run stops without saving',
  'anything if a battle in the middle fails to start. trust is explicit and per call, exactly like',
  'arena_start_battle: with trust false (the default) a harness that declares install or prepare',
  'commands is refused and that battle fails with the exact commands in its error. waitMs bounds how',
  'long one battle is awaited before the next starts (default 10 minutes, max 1 hour). The result is',
  'saved under ARENA_HOME/experiments/<id>.json with summary left null: this call never computes the',
  'win-rate and correctness comparison, only "arena experiment show <id>" does. Arena runs the user\'s',
  'own authenticated agent CLIs on this machine and pays no model costs.',
].join(' ');

const COMPARE_VERSIONS_DESCRIPTION = [
  'Runs a regression experiment pinned to two commits of one harness: from as the control (side a) and',
  'to as the treatment (side b), over every task (or one, with taskId) of a benchmark pack, one battle',
  'at a time. This is arena_run_experiment with kind fixed to "regression" and both sides sharing one',
  'harness source. benchmark is the path to a pack file; agent (default "fake") runs on both sides;',
  "trials overrides every task's own trial count. One battle runs per server process: a call is",
  'refused, naming the battle already running, when this server is busy, and the run stops without',
  'saving anything if a battle in the middle fails to start. trust is explicit and per call, exactly',
  'like arena_start_battle: with trust false (the default) a harness that declares install or prepare',
  'commands is refused and that battle fails with the exact commands in its error. waitMs bounds how',
  'long one battle is awaited before the next starts (default 10 minutes, max 1 hour). The result is',
  'saved under ARENA_HOME/experiments/<id>.json with summary left null; "arena experiment show <id>"',
  "computes it. Arena runs the user's own authenticated agent CLIs on this machine and pays no model",
  'costs.',
].join(' ');

const GET_EXPERIMENT_DESCRIPTION = [
  'Reads a local experiment run record from ARENA_HOME/experiments/<id>.json, written by',
  'arena_run_experiment or arena_compare_versions. Give id to read one record; an unknown id is',
  'reported as an error naming the file that does not exist. Omit id to list the newest local',
  'experiment runs instead (limit controls how many, newest first). The record carries the control and',
  'treatment refs, the per-battle rows, and summary, which is left null by the run tools: the',
  'win-rate and correctness comparison is computed by the CLI ("arena experiment show <id>"), not by',
  "this server. Nothing here runs anything; Arena runs the user's own agent CLIs locally and pays no",
  'model costs.',
].join(' ');

export function registerExperimentsTools(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_run_experiment',
    {
      title: 'Run an experiment',
      description: RUN_EXPERIMENT_DESCRIPTION,
      inputSchema: {
        kind: z.enum(['regression', 'ablation', 'comparison']).describe('why control and treatment differ'),
        control: z.string().min(1).describe('control harness source; "source" or "source@commit"'),
        treatment: z.string().min(1).describe('treatment harness source; "source" or "source@commit"'),
        benchmark: z.string().min(1).describe('path to a benchmark pack file (yaml or json)'),
        taskId: z.string().min(1).optional().describe('run only this task id of the pack'),
        agent: z
          .string()
          .min(1)
          .default('fake')
          .describe('agent id run on both sides (default "fake", which replays fixtures and costs nothing)'),
        trials: z.number().int().min(1).max(20).optional().describe("override every task's own trial count"),
        title: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('title recorded on the experiment; defaults to a generated one'),
        trust: z
          .boolean()
          .default(false)
          .describe('approve the install/prepare commands the harnesses declare; false refuses to run them'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(3_600_000)
          .default(600_000)
          .describe('how long to wait for each battle to finish before starting the next (default 10 min)'),
      },
    },
    async ({ kind, control, treatment, benchmark, taskId, agent, trials, title, trust, waitMs }) =>
      runExperimentCore(ctx, {
        kind,
        control: splitSourceCommit(control),
        treatment: splitSourceCommit(treatment),
        benchmarkFile: benchmark,
        taskId,
        agent,
        trials,
        title,
        trust,
        waitMs,
      }),
  );

  server.registerTool(
    'arena_compare_versions',
    {
      title: 'Compare two commits of one harness',
      description: COMPARE_VERSIONS_DESCRIPTION,
      inputSchema: {
        harness: z.string().min(1).describe('harness source shared by both commits'),
        from: z.string().min(1).describe('control commit (7-40 hex chars)'),
        to: z.string().min(1).describe('treatment commit (7-40 hex chars)'),
        benchmark: z.string().min(1).describe('path to a benchmark pack file (yaml or json)'),
        taskId: z.string().min(1).optional().describe('run only this task id of the pack'),
        agent: z
          .string()
          .min(1)
          .default('fake')
          .describe('agent id run on both sides (default "fake", which replays fixtures and costs nothing)'),
        trials: z.number().int().min(1).max(20).optional().describe("override every task's own trial count"),
        trust: z
          .boolean()
          .default(false)
          .describe('approve the install/prepare commands the harnesses declare; false refuses to run them'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(3_600_000)
          .default(600_000)
          .describe('how long to wait for each battle to finish before starting the next (default 10 min)'),
      },
    },
    async ({ harness, from, to, benchmark, taskId, agent, trials, trust, waitMs }) =>
      runExperimentCore(ctx, {
        kind: 'regression',
        control: { source: harness, commit: from },
        treatment: { source: harness, commit: to },
        benchmarkFile: benchmark,
        taskId,
        agent,
        trials,
        trust,
        waitMs,
      }),
  );

  server.registerTool(
    'arena_get_experiment',
    {
      title: 'Get an experiment run record',
      description: GET_EXPERIMENT_DESCRIPTION,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .optional()
          .describe('experiment id, e.g. exp_xxxxxxxx; omit to list the newest local experiment runs'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe('how many of the newest experiment runs to return when id is omitted'),
      },
    },
    async ({ id, limit }) => {
      if (id === undefined) {
        const records = await listExperimentRunRecords(ctx.home, limit);
        const summary =
          records.length === 0
            ? 'No experiment runs under ' + experimentsDir(ctx.home) + ' yet.'
            : records.length +
              ' experiment run(s); newest ' +
              records[0]?.id +
              ' (' +
              records[0]?.status +
              ').';
        return jsonResult(summary, { home: ctx.home, count: records.length, records });
      }

      const record = await loadExperimentRunRecord(ctx.home, id);
      if (record === null) {
        return errorResult('no experiment ' + id + ' under ' + experimentRecordPath(ctx.home, id) + '.');
      }
      return jsonResult(
        'experiment ' +
          record.id +
          ' (' +
          record.kind +
          '): ' +
          record.status +
          ', ' +
          record.battles.length +
          ' battle(s).',
        { record },
      );
    },
  );
}
