import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ArenaContext } from '../context.js';
import { errorText, jsonResult } from '../result.js';

const DESCRIPTION = [
  "Lists battles stored under this machine's ARENA_HOME, newest first. Each row carries the battle id",
  '(pass it to arena_get_battle, arena_get_results, arena_compare_runs or arena_render_report), the',
  'title, the status (pending, preparing, running, evaluating, completed, failed, cancelled), the',
  'winner when a verdict exists, both competitors with their agent and harness, whether the battle is',
  'demo data, and its timestamps. Demo battles are deterministic fake replays and must never be mixed',
  'with real results. Use this first when the user talks about "the last battle" instead of guessing an id.',
].join(' ');

export function registerListBattles(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_list_battles',
    {
      title: 'List battles',
      description: DESCRIPTION,
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe('how many of the newest battles to return (default 20, max 200)'),
      },
    },
    async ({ limit }) => {
      let battles;
      try {
        battles = await ctx.store.listBattles({ limit });
      } catch (err) {
        return jsonResult('Could not read the battle directory: ' + errorText(err), {
          home: ctx.home,
          count: 0,
          battles: [],
          error: errorText(err),
        });
      }
      const running = ctx.runner.runningId;
      const summary =
        battles.length === 0
          ? 'No battles under ' + ctx.home + ' yet. Start one with arena_start_battle.'
          : battles.length +
            ' battle(s); newest ' +
            battles[0]?.id +
            ' (' +
            battles[0]?.status +
            ')' +
            (running ? ', ' + running + ' is running in this server' : '') +
            '.';
      return jsonResult(summary, { home: ctx.home, count: battles.length, running, battles });
    },
  );
}
