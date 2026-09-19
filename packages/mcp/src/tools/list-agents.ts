import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectAgents } from '@harness-arena/adapters';
import type { ArenaContext } from '../context.js';
import { jsonResult } from '../result.js';

const DESCRIPTION = [
  'Lists the agent CLIs Arena can drive on this machine and what each one can report.',
  'Each entry gives the adapter id to use as competitors.a.agent.id in a battle spec, whether the',
  'official CLI is installed, its version, a best-effort auth check, and a capabilities map saying',
  'which telemetry that CLI exposes (observed), what Arena derives from artifacts (derived), and what',
  "is simply not available. Arena runs the user's own locally authenticated CLI and never reads or",
  'forwards provider credentials, so an agent reporting auth "missing" has to be logged in by the user',
  'before a battle can use it. The built-in "fake" agent is always installed: it replays recorded',
  'fixtures deterministically, costs nothing, and is what the demo battle and the test suite use.',
].join(' ');

export function registerListAgents(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_list_agents',
    { title: 'List agent CLIs', description: DESCRIPTION, inputSchema: {} },
    async () => {
      const detect = ctx.deps.detectAgents ?? detectAgents;
      const detections = await detect(ctx.registry, ctx.env);
      const byId = new Map(detections.map((d) => [d.id as string, d]));

      const agents = ctx.registry.list().map((adapter) => {
        const detection = byId.get(adapter.id);
        return {
          id: adapter.id,
          displayName: adapter.displayName,
          kind: adapter.kind,
          binaryNames: [...adapter.binaryNames],
          installed: detection?.installed ?? false,
          version: detection?.version ?? null,
          path: detection?.path ?? null,
          auth: detection?.auth ?? 'unknown',
          notes: detection?.notes ?? [],
          capabilities: adapter.capabilities(),
        };
      });

      const installed = agents.filter((a) => a.installed);
      const summary =
        installed.length === 0
          ? 'No agent CLI is installed; only the built-in fake agent can run.'
          : installed.length +
            ' of ' +
            agents.length +
            ' agents are installed: ' +
            installed.map((a) => a.id + (a.version ? ' ' + a.version : '')).join(', ') +
            '.';

      return jsonResult(summary, { count: agents.length, installedCount: installed.length, agents });
    },
  );
}
