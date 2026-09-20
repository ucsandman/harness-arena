import { extractRows, type ArenaDatabase } from '@harness-arena/database';

/**
 * The community battles that were produced by running one benchmark pack version, grouped by task.
 *
 * There is no exported query for this yet and `drizzle-orm` is not a dependency of the web app, so
 * this goes through `db.execute()` with a literal statement. The only interpolated value is the pack
 * version id, and it is checked against the protocol's own `bmv_` + 24 hex regex before it reaches
 * the statement: anything else returns no results instead of running. Everything else in the WHERE
 * clause is a constant.
 *
 * Only public, non-demo battles are counted. Side A and side B are per-battle labels chosen by
 * whoever ran the battle, so the per-side counts below describe those battles and are never a ranking.
 */

const VERSION_ID = /^bmv_[0-9a-f]{24}$/;

/** How many battles one task's result block is computed over. */
export const BENCHMARK_RESULT_LIMIT = 500;

export interface BenchmarkBattleRow {
  id: string;
  title: string;
  winner: 'a' | 'b' | 'tie' | 'inconclusive' | null;
  status: string;
  trial: number | null;
  createdAt: string;
}

export interface BenchmarkTaskResults {
  taskId: string;
  battles: number;
  /** battles whose verdict named a side */
  decided: number;
  sideAWins: number;
  sideBWins: number;
  ties: number;
  inconclusive: number;
  /** newest first, capped for display */
  recent: BenchmarkBattleRow[];
}

export interface BenchmarkVersionResults {
  versionId: string;
  /** public, non-demo battles found for this version (capped at BENCHMARK_RESULT_LIMIT) */
  battles: number;
  capped: boolean;
  byTask: BenchmarkTaskResults[];
}

interface RawRow {
  id: string;
  title: string;
  winner: string | null;
  status: string;
  benchmark_task_id: string | null;
  benchmark_trial: number | string | null;
  created_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function empty(versionId: string): BenchmarkVersionResults {
  return { versionId, battles: 0, capped: false, byTask: [] };
}

export async function benchmarkVersionResults(
  db: ArenaDatabase,
  versionId: string,
  recentPerTask = 5,
): Promise<BenchmarkVersionResults> {
  if (!VERSION_ID.test(versionId)) return empty(versionId);

  const statement =
    'select id, title, winner, status, benchmark_task_id, benchmark_trial, created_at ' +
    'from battles ' +
    "where benchmark_version_id = '" +
    versionId +
    "' and visibility = 'public' and demo = false " +
    'order by created_at desc, id desc ' +
    'limit ' +
    String(BENCHMARK_RESULT_LIMIT);

  const result = await db.execute(statement);
  const rows = extractRows(result) as RawRow[];

  const byTask = new Map<string, BenchmarkTaskResults>();
  for (const row of rows) {
    const taskId = row.benchmark_task_id ?? '(unrecorded task)';
    const entry = byTask.get(taskId) ?? {
      taskId,
      battles: 0,
      decided: 0,
      sideAWins: 0,
      sideBWins: 0,
      ties: 0,
      inconclusive: 0,
      recent: [],
    };
    entry.battles += 1;
    if (row.winner === 'a') {
      entry.decided += 1;
      entry.sideAWins += 1;
    } else if (row.winner === 'b') {
      entry.decided += 1;
      entry.sideBWins += 1;
    } else if (row.winner === 'tie') {
      entry.ties += 1;
    } else if (row.winner === 'inconclusive') {
      entry.inconclusive += 1;
    }
    if (entry.recent.length < recentPerTask) {
      const trial = row.benchmark_trial;
      entry.recent.push({
        id: row.id,
        title: row.title,
        winner: (row.winner as BenchmarkBattleRow['winner']) ?? null,
        status: row.status,
        trial: trial === null || trial === undefined ? null : Number(trial),
        createdAt: iso(row.created_at),
      });
    }
    byTask.set(taskId, entry);
  }

  return {
    versionId,
    battles: rows.length,
    capped: rows.length === BENCHMARK_RESULT_LIMIT,
    byTask: [...byTask.values()].sort((a, b) => b.battles - a.battles || a.taskId.localeCompare(b.taskId)),
  };
}
