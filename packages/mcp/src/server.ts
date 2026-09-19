import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRegistry } from '@harness-arena/adapters';
import type { AdapterRegistry, Logger } from '@harness-arena/adapters';
import { ARENA_VERSION, createLogger, createStateStore, defaultHome } from '@harness-arena/core';
import type { StateStore } from '@harness-arena/core';
import type { ArenaContext, ArenaMcpDeps } from './context.js';
import { BattleRunner } from './runner.js';
import { registerTools, TOOL_NAMES } from './tools/index.js';

/**
 * The MCP interface into Harness Arena.
 *
 * This server owns no execution: every tool delegates to @harness-arena/core (battles, state, report),
 * @harness-arena/adapters (which agent CLIs exist and what they can observe) and
 * @harness-arena/harness (harness inspection). It adds exactly three things of its own: one battle at
 * a time per process, explicit per-call trust for harness commands, and caps on what one answer may
 * contain.
 *
 * stdout belongs to the JSON-RPC protocol. Everything this server says to a human goes to stderr.
 */

export interface ArenaMcpServerOptions {
  /** ARENA_HOME for this server; defaults to $ARENA_HOME, else ~/.harness-arena */
  home?: string;
  registry?: AdapterRegistry;
  /** defaults to a warn-level logger that writes to stderr */
  logger?: Logger;
  deps?: ArenaMcpDeps;
  env?: Record<string, string | undefined>;
}

export interface ArenaMcpServer {
  readonly server: McpServer;
  readonly home: string;
  readonly store: StateStore;
  /** battle id running in this process, or null */
  readonly runningId: string | null;
  /** aborts a running battle, waits for it to settle, then closes the transport */
  close(): Promise<void>;
}

export function createArenaMcpServer(opts: ArenaMcpServerOptions = {}): ArenaMcpServer {
  const env = opts.env ?? process.env;
  const home = opts.home ?? defaultHome(env);
  const store = createStateStore(home);
  const registry = opts.registry ?? createRegistry();
  const logger = opts.logger ?? createLogger({ level: 'warn', pretty: true });
  const runner = new BattleRunner();
  const aborter = new AbortController();

  const server = new McpServer(
    { name: 'harness-arena', version: ARENA_VERSION, title: 'Harness Arena' },
    {
      capabilities: { tools: {} },
      instructions: [
        'Harness Arena battles two AI coding-agent harnesses on the same task using the official,',
        'locally authenticated agent CLIs on this machine, then evaluates both runs deterministically.',
        'Arena never pays model costs and never reads provider credentials.',
        'Read first: arena_list_battles then arena_get_results or arena_compare_runs for an existing',
        'battle; arena_list_agents for what can run here; arena_inspect_harness before trusting a harness.',
        'Write: arena_start_battle validates the spec, runs one battle at a time and returns an id to poll',
        'with arena_get_battle; harness install or prepare commands run only when that call passes',
        'trust: true, which you must ask the user for after showing them the exact commands.',
      ].join(' '),
    },
  );

  const ctx: ArenaContext = {
    home,
    store,
    registry,
    logger: logger.child({ component: 'mcp' }),
    env,
    deps: opts.deps ?? {},
    runner,
    signal: aborter.signal,
  };

  registerTools(server, ctx);

  return {
    server,
    home,
    store,
    get runningId() {
      return runner.runningId;
    },
    async close() {
      if (runner.busy) {
        logger.warn('closing while a battle is running: aborting it', { battle: runner.runningId });
        aborter.abort();
        await runner.idle();
      }
      await server.close();
    },
  };
}

export { TOOL_NAMES };
