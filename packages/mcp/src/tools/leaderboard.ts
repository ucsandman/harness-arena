import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ArenaContext } from '../context.js';

/** arena_get_leaderboard, arena_get_harness_profile, arena_get_rating, arena_get_head_to_head, arena_get_insights (read the server). */
export function registerLeaderboardTools(_server: McpServer, _ctx: ArenaContext): void {
  // implemented by the leaderboard workstream
}
