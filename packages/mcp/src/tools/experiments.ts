import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ArenaContext } from '../context.js';

/** arena_run_experiment, arena_compare_versions, arena_get_experiment. */
export function registerExperimentsTools(_server: McpServer, _ctx: ArenaContext): void {
  // implemented by the experiments workstream
}
