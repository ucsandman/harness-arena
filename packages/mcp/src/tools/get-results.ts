import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computeInsights } from '@harness-arena/core';
import type { ArenaContext } from '../context.js';
import { errorResult, jsonResult } from '../result.js';

const DESCRIPTION = [
  'Returns just the outcome of a battle: the verdict (winner a, b, tie or inconclusive, with its',
  'confidence, method, reasons, decisive factors and caveats), the full evaluation report (every',
  'evaluator result, the metric comparisons, the evidence rows and the evaluators that could not run',
  'with the reason), and the insights derived from telemetry. A verdict is deterministic unless the',
  'battle enabled the optional LLM judge, whose opinion is always labelled subjective and never decides',
  'a winner on its own. Use this instead of arena_get_battle when the question is "who won and why";',
  'it carries no event stream and no spec.',
].join(' ');

export function registerGetResults(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_get_results',
    {
      title: 'Get battle results',
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

      let insights = record.insights;
      let insightsSource = 'record';
      if (insights.length === 0) {
        const events = await ctx.store.readEvents(id);
        insights = computeInsights(record, events);
        insightsSource = events.length === 0 ? 'none' : 'computed';
      }

      const verdict = record.verdict;
      const labels = { a: record.runs.a.label, b: record.runs.b.label };
      const winnerLabel =
        verdict === null
          ? 'no verdict yet'
          : verdict.winner === 'a'
            ? labels.a + ' wins'
            : verdict.winner === 'b'
              ? labels.b + ' wins'
              : verdict.winner;

      const summary =
        'Battle ' +
        id +
        ' (' +
        record.status +
        '): ' +
        winnerLabel +
        (verdict ? ' with confidence ' + verdict.confidence.toFixed(2) + ' (' + verdict.method + ')' : '') +
        '. ' +
        insights.length +
        ' insight(s).' +
        (record.demo ? ' Demo data: deterministic fake replay, not a real result.' : '');

      return jsonResult(summary, {
        id,
        status: record.status,
        demo: record.demo,
        labels,
        verdict,
        evaluation: record.evaluation,
        insights,
        insightsSource,
        error: record.error,
      });
    },
  );
}
