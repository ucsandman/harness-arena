import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ArenaContext } from '../context.js';
import { registerCompareRuns } from './compare-runs.js';
import { registerGetBattle } from './get-battle.js';
import { registerGetResults } from './get-results.js';
import { registerInspectHarness } from './inspect-harness.js';
import { registerListAgents } from './list-agents.js';
import { registerListBattles } from './list-battles.js';
import { registerListHarnesses } from './list-harnesses.js';
import { registerRenderReport } from './render-report.js';
import { registerStartBattle } from './start-battle.js';
import { registerBenchmarksTools } from './benchmarks.js';
import { registerExperimentsTools } from './experiments.js';
import { registerChallengesTools } from './challenges.js';
import { registerLeaderboardTools } from './leaderboard.js';

/** Every tool this server exposes, in the order a client sees them. */
export const TOOL_NAMES = [
  'arena_list_agents',
  'arena_list_battles',
  'arena_get_battle',
  'arena_get_results',
  'arena_compare_runs',
  'arena_list_harnesses',
  'arena_inspect_harness',
  'arena_start_battle',
  'arena_render_report',
  'arena_list_benchmarks',
  'arena_run_benchmark',
  'arena_run_experiment',
  'arena_compare_versions',
  'arena_get_experiment',
  'arena_create_challenge',
  'arena_get_challenge',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function registerTools(server: McpServer, ctx: ArenaContext): void {
  registerListAgents(server, ctx);
  registerListBattles(server, ctx);
  registerGetBattle(server, ctx);
  registerGetResults(server, ctx);
  registerCompareRuns(server, ctx);
  registerListHarnesses(server, ctx);
  registerInspectHarness(server, ctx);
  registerStartBattle(server, ctx);
  registerRenderReport(server, ctx);
  registerBenchmarksTools(server, ctx);
  registerExperimentsTools(server, ctx);
  registerChallengesTools(server, ctx);
  registerLeaderboardTools(server, ctx);
}

export { EVENT_CAP, EVENT_DEFAULT_LIMIT } from './get-battle.js';
export { HARNESS_CAP } from './list-harnesses.js';
