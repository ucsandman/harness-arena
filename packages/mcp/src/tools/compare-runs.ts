import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { compareMetrics } from '@harness-arena/evaluator';
import type { ArenaContext } from '../context.js';
import { metricCell } from '../format.js';
import { errorResult, jsonResult } from '../result.js';

const DESCRIPTION = [
  'Returns the side-by-side metric table for a battle: one row per protocol metric with its label, side',
  "A and side B values, each value's status badge (observed = the CLI reported it, calculated = Arena",
  'derived it, estimated = a labelled heuristic, n/a = the CLI does not expose it), which side is better,',
  'and how much the difference matters (decisive, notable, minor, none). A metric neither side reports',
  'stays n/a with a null value: it is never rendered as zero and never decides anything. "better" is only',
  'a or b when both values are real comparable numbers, otherwise it is "n/a". Rows come from',
  'compareMetrics in the evaluator, the same computation the report and the web UI use.',
].join(' ');

export function registerCompareRuns(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_compare_runs',
    {
      title: 'Compare the two runs',
      description: DESCRIPTION,
      inputSchema: {
        id: z.string().min(1).describe('battle id, e.g. btl_3f9a1c2b (from arena_list_battles)'),
      },
    },
    async ({ id }) => {
      const record = await ctx.store.loadRecord(id).catch(() => null);
      if (record === null) {
        return errorResult(
          'no battle ' + id + ' under ' + ctx.home + '. Call arena_list_battles for the ids that exist.',
        );
      }

      const comparisons = compareMetrics(record.runs.a.metrics, record.runs.b.metrics);
      const rows = comparisons.map((c) => ({
        key: c.key,
        label: c.label,
        a: metricCell(c.key, c.a),
        b: metricCell(c.key, c.b),
        better: c.better,
        significance: c.significance,
      }));

      const decisive = rows.filter((r) => r.significance === 'decisive');
      const notable = rows.filter((r) => r.significance === 'notable');
      const unavailable = rows.filter((r) => r.a.status === 'unavailable' && r.b.status === 'unavailable');

      const summary =
        'Battle ' +
        id +
        ': ' +
        rows.length +
        ' metrics, ' +
        decisive.length +
        ' decisive, ' +
        notable.length +
        ' notable, ' +
        unavailable.length +
        ' not reported by either CLI (n/a).';

      return jsonResult(summary, {
        id,
        labels: { a: record.runs.a.label, b: record.runs.b.label },
        agents: { a: record.runs.a.agent.id, b: record.runs.b.agent.id },
        harnesses: { a: record.runs.a.harness.name, b: record.runs.b.harness.name },
        winner: record.verdict?.winner ?? null,
        rows,
        decisive: decisive.map((r) => r.key),
        notable: notable.map((r) => r.key),
        unavailableBothSides: unavailable.map((r) => r.key),
      });
    },
  );
}
