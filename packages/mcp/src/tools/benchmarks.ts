import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  benchmarkBattleCount,
  BenchmarkPackError,
  expandBenchmark,
  listBenchmarkPackFiles,
  loadBenchmarkPack,
  runBattle,
} from '@harness-arena/core';
import type { LoadedBenchmarkPack } from '@harness-arena/core';
import { benchmarkCategories } from '@harness-arena/protocol';
import type { BattleSpecInput, CompetitorSpec } from '@harness-arena/protocol';
import type { ArenaContext } from '../context.js';
import { errorResult, errorText, jsonResult } from '../result.js';

/**
 * Benchmark packs: listing what is on disk (`arena_list_benchmarks`) and running one as a sequence of
 * battles (`arena_run_benchmark`). Nothing here runs a battle outside `ctx.runner`, and no benchmark pack
 * ever declares who runs it: the competitors always come from the call's own `a`/`b` arguments.
 */

/** `examples/benchmarks` next to the repository checkout this package runs from, when there is one. */
function repoBenchmarksDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../examples/benchmarks');
}

function homeBenchmarksDir(ctx: ArenaContext): string {
  return path.join(ctx.home, 'benchmarks');
}

function allPackFiles(ctx: ArenaContext): string[] {
  return [...listBenchmarkPackFiles(repoBenchmarksDir()), ...listBenchmarkPackFiles(homeBenchmarksDir(ctx))];
}

interface PackSummary {
  file: string;
  slug: string;
  name: string;
  version: string;
  versionId: string;
  description: string | null;
  taskCount: number;
  battlesPerRun: number;
  categories: string[];
  visibility: string;
  tasks: Array<{ id: string; title: string; category: string; trials: number }>;
}

async function summarizePack(file: string): Promise<PackSummary> {
  const { pack, versionId } = await loadBenchmarkPack(file);
  return {
    file,
    slug: pack.slug,
    name: pack.name,
    version: pack.version,
    versionId,
    description: pack.description ?? null,
    taskCount: pack.tasks.length,
    battlesPerRun: benchmarkBattleCount(pack),
    categories: benchmarkCategories(pack),
    visibility: pack.visibility,
    tasks: pack.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      category: task.category,
      trials: task.trials,
    })),
  };
}

/** Loads a pack by explicit file path or by slug, searched across both benchmark directories. */
async function resolvePack(
  ctx: ArenaContext,
  args: { file?: string; slug?: string },
): Promise<{ file: string; loaded: LoadedBenchmarkPack }> {
  if (args.file !== undefined) {
    const file = path.resolve(args.file);
    return { file, loaded: await loadBenchmarkPack(file) };
  }
  const slug = args.slug as string;
  for (const file of allPackFiles(ctx)) {
    try {
      const loaded = await loadBenchmarkPack(file);
      if (loaded.pack.slug === slug) return { file, loaded };
    } catch {
      // an unreadable pack never matches a slug; arena_list_benchmarks reports it separately
    }
  }
  throw new BenchmarkPackError(
    'no benchmark pack with slug "' +
      slug +
      '" found under ' +
      repoBenchmarksDir() +
      ' or ' +
      homeBenchmarksDir(ctx),
    slug,
  );
}

const LIST_DESCRIPTION = [
  "Lists benchmark pack files found on this machine: every pack under the repository's",
  'examples/benchmarks directory (when this server runs from a checkout) and every pack under',
  'ARENA_HOME/benchmarks. A pack is a YAML or JSON file (benchmark: 1) describing a versioned set of',
  'tasks; its versionId is the sha256 of its canonical content, so editing one task produces a new',
  'version instead of silently changing history. Pass limit to cap how many pack files are inspected.',
  'A pack file that cannot be read or fails validation is reported in problems instead of stopping the',
  "listing. Nothing here runs anything: Arena runs the user's own agent CLIs locally, pays no model",
  'costs and reads no provider credentials; this tool only reads files already on disk.',
].join(' ');

const RUN_DESCRIPTION = [
  'Runs a benchmark pack, or one task of it, as a sequence of battles between side a and side b: one',
  'battle at a time, waiting for each to finish before the next starts so two never overlap. Give',
  'either file (a path to a pack file) or slug (a pack already found by arena_list_benchmarks), never',
  'both. a and b are harness sources ("vanilla" or a git/GitHub URL); agent is the agent id run on both',
  'sides, defaulting to "fake" (replays fixtures: no network, no model spend). trials overrides every',
  "task's own trial count; taskId runs only that one task. One battle runs per server process: a call",
  'is refused, naming the battle already running, when this server is busy. trust is explicit and per',
  'call, exactly like arena_start_battle: with trust false (the default) a harness that declares',
  'install or prepare commands is refused and that battle fails with the exact commands in its error,',
  'having executed nothing; a harness.trusted field is never read from anywhere here, only this',
  'argument can approve a command. waitMs bounds how long one battle is awaited before the next starts',
  "(default 10 minutes, max 1 hour). Arena runs the user's own authenticated agent CLIs on this",
  'machine and pays no model costs.',
].join(' ');

interface BenchmarkBattleRow {
  battleId: string | null;
  taskId: string | null;
  trial: number;
  status: string;
  winner: string | null;
  error: string | null;
}

export function registerBenchmarksTools(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_list_benchmarks',
    {
      title: 'List benchmark packs',
      description: LIST_DESCRIPTION,
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('cap how many pack files are inspected (default: every pack file found)'),
      },
    },
    async ({ limit }) => {
      const repoDir = repoBenchmarksDir();
      const home = homeBenchmarksDir(ctx);
      let files = [...listBenchmarkPackFiles(repoDir), ...listBenchmarkPackFiles(home)];
      if (limit !== undefined) files = files.slice(0, limit);

      const packs: PackSummary[] = [];
      const problems: Array<{ file: string; error: string }> = [];
      for (const file of files) {
        try {
          packs.push(await summarizePack(file));
        } catch (err) {
          problems.push({ file, error: errorText(err) });
        }
      }

      const first = packs[0];
      const summary =
        packs.length === 0
          ? 'No benchmark packs found under ' +
            repoDir +
            ' or ' +
            home +
            (problems.length > 0 ? '; ' + problems.length + ' file(s) could not be read.' : '.')
          : packs.length +
            ' benchmark pack(s) found' +
            (problems.length > 0 ? ' (' + problems.length + ' unreadable)' : '') +
            '; first ' +
            first?.slug +
            ' (' +
            first?.taskCount +
            ' task(s)).';

      return jsonResult(summary, { home: ctx.home, count: packs.length, packs, problems });
    },
  );

  server.registerTool(
    'arena_run_benchmark',
    {
      title: 'Run a benchmark pack',
      description: RUN_DESCRIPTION,
      inputSchema: {
        file: z
          .string()
          .min(1)
          .optional()
          .describe('path to a benchmark pack file (yaml or json); mutually exclusive with slug'),
        slug: z
          .string()
          .min(1)
          .optional()
          .describe('slug of a pack already found by arena_list_benchmarks; mutually exclusive with file'),
        a: z.string().min(1).describe('harness source for side a, e.g. "vanilla" or a GitHub URL'),
        b: z.string().min(1).describe('harness source for side b'),
        agent: z
          .string()
          .min(1)
          .default('fake')
          .describe('agent id run on both sides (default "fake", which replays fixtures and costs nothing)'),
        trials: z.number().int().min(1).max(20).optional().describe("override every task's own trial count"),
        taskId: z.string().min(1).optional().describe('run only this task id of the pack'),
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
    async ({ file, slug, a, b, agent, trials, taskId, trust, waitMs }) => {
      if ((file === undefined) === (slug === undefined)) {
        return errorResult(
          'give exactly one of file (a path to a pack) or slug (a pack found by arena_list_benchmarks).',
        );
      }

      let loaded: LoadedBenchmarkPack;
      let resolvedFile: string;
      try {
        const resolved = await resolvePack(ctx, { file, slug });
        loaded = resolved.loaded;
        resolvedFile = resolved.file;
      } catch (err) {
        return errorResult('could not load the benchmark pack: ' + errorText(err));
      }

      if (ctx.runner.busy) {
        return errorResult(
          'battle ' +
            (ctx.runner.runningId ?? 'unknown') +
            ' is already running in this server; one battle runs at a time. Poll it with arena_get_battle ' +
            'and start the next one when it is done.',
        );
      }

      const competitorA: CompetitorSpec = { agent: { id: agent }, harness: { source: a, trusted: false } };
      const competitorB: CompetitorSpec = { agent: { id: agent }, harness: { source: b, trusted: false } };

      let specs: BattleSpecInput[];
      try {
        specs = expandBenchmark(loaded.pack, loaded.versionId, {
          a: competitorA,
          b: competitorB,
          trials,
          taskId,
          privacy: { upload: 'none', exclude: [], redact: true },
        });
      } catch (err) {
        return errorResult('could not expand ' + resolvedFile + ': ' + errorText(err));
      }

      const run = ctx.deps.runBattle ?? runBattle;
      const rows: BenchmarkBattleRow[] = [];

      for (const spec of specs) {
        if (ctx.runner.busy) {
          return errorResult(
            'battle ' +
              (ctx.runner.runningId ?? 'unknown') +
              ' is already running in this server; one battle runs at a time.',
          );
        }

        const outcome = await ctx.runner.start({
          trusted: trust,
          waitMs,
          run: (hooks) =>
            run(spec, {
              home: ctx.home,
              registry: ctx.registry,
              logger: ctx.logger,
              signal: ctx.signal,
              onEvent: hooks.onEvent,
              onStatus: hooks.onStatus,
              trust: async (harness, exec) => {
                if (!trust) {
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

        const specTaskId = spec.benchmark?.taskId ?? null;
        const specTrial = spec.benchmark?.trial ?? 1;

        if (outcome.kind === 'busy') {
          rows.push({
            battleId: null,
            taskId: specTaskId,
            trial: specTrial,
            status: 'failed',
            winner: null,
            error:
              'battle ' +
              (outcome.runningId ?? 'unknown') +
              ' is already running in this server; one battle runs at a time.',
          });
          continue;
        }
        if (outcome.kind === 'failed') {
          rows.push({
            battleId: null,
            taskId: specTaskId,
            trial: specTrial,
            status: 'failed',
            winner: null,
            error: outcome.message,
          });
          continue;
        }

        const handle = outcome.handle;
        const record = outcome.finished ? await ctx.store.loadRecord(handle.id).catch(() => null) : null;
        const status = record?.status ?? handle.status;
        rows.push({
          battleId: handle.id,
          taskId: specTaskId,
          trial: specTrial,
          status,
          winner: record?.verdict?.winner ?? null,
          error: record?.error ?? handle.error,
        });
      }

      const completed = rows.filter((r) => r.status === 'completed').length;
      const failed = rows.filter((r) => r.status === 'failed').length;
      const wins = {
        a: rows.filter((r) => r.winner === 'a').length,
        b: rows.filter((r) => r.winner === 'b').length,
        ties: rows.filter((r) => r.winner === 'tie').length,
        inconclusive: rows.filter((r) => r.winner === 'inconclusive').length,
      };

      const summary =
        rows.length +
        ' battle(s) run over ' +
        loaded.pack.slug +
        ': ' +
        completed +
        ' completed, ' +
        failed +
        ' failed. Wins: a=' +
        wins.a +
        ' b=' +
        wins.b +
        ' tie=' +
        wins.ties +
        '.';

      return jsonResult(summary, {
        slug: loaded.pack.slug,
        versionId: loaded.versionId,
        battles: rows,
        completed,
        failed,
        wins,
      });
    },
  );
}
