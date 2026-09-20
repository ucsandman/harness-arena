import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYamlDocument } from 'yaml';
import { z } from 'zod';
import {
  agentRefSchema,
  benchmarkPackSchema,
  benchmarkVersionId,
  changedComponentSchema,
  competitorRefSchema,
  experimentKindSchema,
  experimentStatusSchema,
  experimentSummarySchema,
  makeId,
} from '@harness-arena/protocol';
import type {
  AgentRef,
  BattleArenaLinks,
  BattleSpecInput,
  BenchmarkPack,
  BenchmarkTask,
  CompetitorSpec,
  PrivacySettings,
  Visibility,
} from '@harness-arena/protocol';

/**
 * Benchmark packs on disk, and the local record of an experiment run.
 *
 * A pack is a YAML or JSON file. Its identity is the sha256 of its canonical content
 * (`benchmarkVersionId`), so two files that differ only in key order or formatting are the same
 * version, and editing one task produces a new version instead of silently changing history.
 *
 * Expanding a pack produces plain battle specs: one per task per trial, carrying the provenance the
 * server and the ratings need (`spec.benchmark`). Nothing here runs a battle.
 */

export const BENCHMARK_FILE_EXTENSIONS = ['.yaml', '.yml', '.json'] as const;

export class BenchmarkPackError extends Error {
  readonly file: string;
  readonly problems: string[];

  constructor(message: string, file: string, problems: string[] = []) {
    super(message);
    this.name = 'BenchmarkPackError';
    this.file = file;
    this.problems = problems;
  }
}

function issueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => (issue.path.join('.') || '(root)') + ': ' + issue.message);
}

/** Parse pack text. YAML is a superset of JSON, so one parser handles both; the extension only labels it. */
export function parseBenchmarkPackText(text: string, file = '<inline>'): BenchmarkPack {
  let raw: unknown;
  try {
    raw = file.toLowerCase().endsWith('.json') ? (JSON.parse(text) as unknown) : parseYamlDocument(text);
  } catch (err) {
    throw new BenchmarkPackError(
      file +
        ' is not valid ' +
        (file.toLowerCase().endsWith('.json') ? 'JSON' : 'YAML') +
        ': ' +
        (err instanceof Error ? err.message : String(err)),
      file,
    );
  }
  if (raw === null || typeof raw !== 'object') {
    throw new BenchmarkPackError(file + ' is empty or is not a benchmark pack object', file);
  }
  const parsed = benchmarkPackSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = issueLines(parsed.error);
    throw new BenchmarkPackError(
      file + ' is not a valid benchmark pack: ' + problems.join('; '),
      file,
      problems,
    );
  }
  return parsed.data;
}

export interface LoadedBenchmarkPack {
  pack: BenchmarkPack;
  /** `bmv_` + 24 hex chars of sha256 over the canonical pack content */
  versionId: string;
}

/** Read and validate a pack file (`.yaml`, `.yml` or `.json`) and compute its content version id. */
export async function loadBenchmarkPack(file: string): Promise<LoadedBenchmarkPack> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new BenchmarkPackError(
      'could not read the benchmark pack ' + file + ': ' + (err instanceof Error ? err.message : String(err)),
      file,
    );
  }
  const pack = parseBenchmarkPackText(text, file);
  return { pack, versionId: await benchmarkVersionId(pack) };
}

/** Every pack file directly inside a directory, sorted, `pack.yaml` in a subdirectory included. */
export function listBenchmarkPackFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const candidate of ['pack.yaml', 'pack.yml', 'pack.json']) {
        const nested = path.join(full, candidate);
        if (fs.existsSync(nested)) {
          files.push(nested);
          break;
        }
      }
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if ((BENCHMARK_FILE_EXTENSIONS as readonly string[]).includes(ext)) files.push(full);
  }
  return files;
}

// ---- expansion ---------------------------------------------------------------------------------

export interface ExpandBenchmarkOptions {
  a: CompetitorSpec;
  b: CompetitorSpec;
  /** applied to both sides, overriding the agent each competitor carries */
  agent?: AgentRef;
  /** runs per task; replaces the task's own `trials` when given */
  trials?: number;
  privacy?: PrivacySettings;
  visibility?: Visibility;
  arena?: BattleArenaLinks;
  /** run one task of the pack instead of all of them */
  taskId?: string;
  /** merged into every produced spec, last; used to pin a repository or add tags */
  overrides?: Partial<BattleSpecInput>;
}

const MAX_TITLE = 200;

export function benchmarkBattleTitle(packName: string, task: BenchmarkTask, trial: number): string {
  return (packName + ' · ' + task.title + ' (trial ' + String(trial) + ')').slice(0, MAX_TITLE);
}

function withAgent(competitor: CompetitorSpec, agent?: AgentRef): CompetitorSpec {
  if (!agent) return competitor;
  return { ...competitor, agent: { ...competitor.agent, ...agent } };
}

/**
 * One battle spec per task per trial, in pack order, trials ascending. The competitors come from the
 * caller (a pack never names who runs it); everything else comes from the task, so two people running
 * the same pack version run exactly the same work.
 */
export function expandBenchmark(
  pack: BenchmarkPack,
  versionId: string,
  opts: ExpandBenchmarkOptions,
): BattleSpecInput[] {
  const tasks = opts.taskId ? pack.tasks.filter((task) => task.id === opts.taskId) : pack.tasks;
  if (tasks.length === 0) {
    throw new BenchmarkPackError(
      'no task "' +
        String(opts.taskId) +
        '" in ' +
        pack.slug +
        '; tasks: ' +
        pack.tasks.map((t) => t.id).join(', '),
      pack.slug,
    );
  }
  const a = withAgent(opts.a, opts.agent);
  const b = withAgent(opts.b, opts.agent);
  const specs: BattleSpecInput[] = [];
  for (const task of tasks) {
    const trials = Math.max(1, opts.trials ?? task.trials);
    for (let trial = 1; trial <= trials; trial++) {
      specs.push({
        version: 1,
        title: benchmarkBattleTitle(pack.name, task, trial),
        task: task.task,
        repository: task.repository,
        competitors: { a, b },
        limits: task.limits,
        evaluation: task.evaluation,
        privacy: opts.privacy ?? { upload: 'none' },
        visibility: opts.visibility ?? pack.visibility,
        tags: task.tags,
        category: task.category,
        benchmark: {
          slug: pack.slug,
          versionId,
          version: pack.version,
          taskId: task.id,
          trial,
        },
        ...(opts.arena ? { arena: opts.arena } : {}),
        ...(opts.overrides ?? {}),
      });
    }
  }
  return specs;
}

/** How many battles one full run of a pack produces (its trials, or `trials` per task when forced). */
export function benchmarkBattleCount(pack: BenchmarkPack, trials?: number): number {
  return pack.tasks.reduce((total, task) => total + Math.max(1, trials ?? task.trials), 0);
}

// ---- local experiment records ------------------------------------------------------------------

/**
 * What an experiment run leaves on the machine that ran it, under
 * `<ARENA_HOME>/experiments/<id>.json`. The server copy is optional: the summary is computed from
 * the battle records locally, so `arena experiment run` and `arena_run_experiment` are complete
 * offline and `arena_get_experiment` can read a run back without a network call.
 */
export const experimentBattleRefSchema = z.object({
  battleId: z.string(),
  /** which side of that battle was the treatment */
  treatmentSide: z.enum(['a', 'b']),
  taskId: z.string().nullable().default(null),
  trial: z.number().int().min(1).default(1),
  status: z.string(),
  winner: z.enum(['a', 'b', 'tie', 'inconclusive']).nullable().default(null),
  /** true when the battle reached the server */
  uploaded: z.boolean().default(false),
  url: z.string().nullable().default(null),
});
export type ExperimentBattleRef = z.infer<typeof experimentBattleRefSchema>;

export const experimentRunRecordSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  kind: experimentKindSchema,
  status: experimentStatusSchema,
  control: competitorRefSchema,
  treatment: competitorRefSchema,
  changedComponent: changedComponentSchema.nullable().default(null),
  agent: agentRefSchema,
  /** the pack this ran, when it ran a pack */
  benchmark: z
    .object({ slug: z.string(), versionId: z.string(), version: z.string(), name: z.string() })
    .nullable()
    .default(null),
  /** the spec directory this ran, when it ran loose specs instead of a pack */
  specDir: z.string().nullable().default(null),
  trials: z.number().int().min(1).default(1),
  battles: z.array(experimentBattleRefSchema).default([]),
  summary: experimentSummarySchema.nullable().default(null),
  /** where it was uploaded, when it was */
  server: z
    .object({ url: z.string(), experimentUrl: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  createdAt: z.string(),
  completedAt: z.string().nullable().default(null),
});
export type ExperimentRunRecord = z.infer<typeof experimentRunRecordSchema>;
export type ExperimentRunRecordInput = z.input<typeof experimentRunRecordSchema>;

export function newExperimentId(): string {
  return makeId('experiment');
}

export function experimentsDir(home: string): string {
  return path.join(home, 'experiments');
}

export function experimentRecordPath(home: string, id: string): string {
  return path.join(experimentsDir(home), id + '.json');
}

/** Write (or replace) the local record. Returns the file it wrote. */
export async function saveExperimentRunRecord(
  home: string,
  record: ExperimentRunRecordInput,
): Promise<string> {
  const parsed = experimentRunRecordSchema.parse(record);
  const file = experimentRecordPath(home, parsed.id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return file;
}

/** Read one local record, or null when the machine has no such run. */
export async function loadExperimentRunRecord(home: string, id: string): Promise<ExperimentRunRecord | null> {
  // An id is a file name here: anything with a separator would escape the experiments directory.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  let text: string;
  try {
    text = await fsp.readFile(experimentRecordPath(home, id), 'utf8');
  } catch {
    return null;
  }
  const parsed = experimentRunRecordSchema.safeParse(JSON.parse(text) as unknown);
  return parsed.success ? parsed.data : null;
}

/** Local experiment records, newest first. */
export async function listExperimentRunRecords(home: string, limit = 20): Promise<ExperimentRunRecord[]> {
  let names: string[];
  try {
    names = await fsp.readdir(experimentsDir(home));
  } catch {
    return [];
  }
  const records: ExperimentRunRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = await loadExperimentRunRecord(home, name.slice(0, -'.json'.length));
    if (record) records.push(record);
  }
  records.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
  return records.slice(0, Math.max(1, limit));
}
