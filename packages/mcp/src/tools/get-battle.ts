import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eventTypeSchema } from '@harness-arena/protocol';
import type { ArenaEvent } from '@harness-arena/protocol';
import type { ArenaContext } from '../context.js';
import { errorResult, jsonResult } from '../result.js';

/** Hard ceiling on events returned by one call, whatever the caller asks for. */
export const EVENT_CAP = 2000;
/** Returned when the caller gives no limit. */
export const EVENT_DEFAULT_LIMIT = 200;

const DESCRIPTION = [
  'Returns the full battle record for one id: spec, resolved task, repository and commit, environment,',
  'both runs with their metrics, the evaluation report, the verdict and the insights. Set includeEvents',
  'to also get the telemetry stream; events are the per-run timeline (tool calls, commands, model',
  'responses, file changes, test runs) and there can be thousands, so a call returns at most ' +
    EVENT_CAP +
    ' of them',
  '(default ' + EVENT_DEFAULT_LIMIT + ') and reports events.truncated with the total count when it cut',
  'the list; narrow with eventTypes to get the ones you need. Page forward with afterSeq: pass the',
  'events.nextAfterSeq of the previous answer and only events after that seq come back, so the live tail',
  'of a battle with thousands of events is reachable (events.total and events.matched then count from that',
  'cursor). Poll this tool to follow a battle started with arena_start_battle: status moves through',
  'preparing, running and evaluating to completed or failed.',
].join(' ');

function summarize(record: { id: string; status: string; verdict: { winner: string } | null }): string {
  const winner = record.verdict ? ', winner ' + record.verdict.winner : '';
  return 'Battle ' + record.id + ': ' + record.status + winner + '.';
}

export function registerGetBattle(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_get_battle',
    {
      title: 'Get a battle record',
      description: DESCRIPTION,
      inputSchema: {
        id: z.string().min(1).describe('battle id, e.g. btl_3f9a1c2b (from arena_list_battles)'),
        includeEvents: z
          .boolean()
          .default(false)
          .describe('include the telemetry event stream as well as the record'),
        eventTypes: z
          .array(eventTypeSchema)
          .max(30)
          .optional()
          .describe('only return events of these types, e.g. ["tool.called","command.completed"]'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(EVENT_CAP)
          .optional()
          .describe('max events to return (default ' + EVENT_DEFAULT_LIMIT + ', hard cap ' + EVENT_CAP + ')'),
        afterSeq: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('only events with seq greater than this; pass events.nextAfterSeq to get the next page'),
      },
    },
    async ({ id, includeEvents, eventTypes, limit, afterSeq }) => {
      const record = await ctx.store.loadRecord(id).catch(() => null);
      if (record === null) {
        return errorResult(
          'no battle ' + id + ' under ' + ctx.home + '. Call arena_list_battles for the ids that exist.',
        );
      }

      const handle = ctx.runner.get(id);
      const running = ctx.runner.runningId === id;
      const data: Record<string, unknown> = {
        id: record.id,
        // While this server still owns the battle the runner's view wins: the record on disk turns
        // terminal before the report, upload and workspace cleanup finish, and the next battle can only
        // start once the runner has let go.
        status: running && handle ? handle.status : record.status,
        running,
        startedInThisServer: handle !== undefined,
        record,
      };

      if (!includeEvents) {
        data.events = { included: false, hint: 'call again with includeEvents true for the timeline' };
        return jsonResult(summarize({ ...record, status: String(data.status) }), data);
      }

      const all = await ctx.store.readEvents(id, afterSeq === undefined ? {} : { afterSeq });
      const wanted = new Set(eventTypes ?? []);
      const filtered: ArenaEvent[] = wanted.size > 0 ? all.filter((e) => wanted.has(e.type)) : all;
      const cap = Math.min(limit ?? EVENT_DEFAULT_LIMIT, EVENT_CAP);
      const returned = filtered.slice(0, cap);
      // The cursor for the next poll: everything up to here has been handed over. With nothing to
      // return it stays where the caller was, so a poll on a quiet battle never rewinds the stream.
      const last = returned.at(-1);
      const nextAfterSeq = last === undefined ? (afterSeq ?? null) : last.seq;
      data.events = {
        included: true,
        afterSeq: afterSeq ?? null,
        total: all.length,
        matched: filtered.length,
        returned: returned.length,
        cap,
        truncated: filtered.length > returned.length,
        nextAfterSeq,
        eventTypes: eventTypes ?? null,
        items: returned,
      };

      const truncatedNote =
        filtered.length > returned.length
          ? ' Returned ' +
            returned.length +
            ' of ' +
            filtered.length +
            ' matching events (truncated); poll again with afterSeq ' +
            nextAfterSeq +
            ' for the next page.'
          : ' Returned all ' + returned.length + ' matching events.';
      return jsonResult(summarize({ ...record, status: String(data.status) }) + truncatedNote, data);
    },
  );
}
