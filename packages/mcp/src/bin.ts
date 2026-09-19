#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createArenaMcpServer } from './server.js';

/**
 * `harness-arena-mcp`: the Arena MCP server over stdio.
 *
 * stdin/stdout carry JSON-RPC and nothing else; diagnostics go to stderr. Register it with
 * `claude mcp add harness-arena -- npx -y @harness-arena/mcp`, or point any MCP client at this
 * binary with ARENA_HOME set if the state directory is not ~/.harness-arena.
 */

async function main(): Promise<void> {
  const arena = createArenaMcpServer();
  const transport = new StdioServerTransport();
  await arena.server.connect(transport);
  process.stderr.write('harness-arena mcp server ready (ARENA_HOME ' + arena.home + ')\n');

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    process.stderr.write('harness-arena mcp server stopping (' + signal + ')\n');
    void arena.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  transport.onclose = () => shutdown('stdio closed');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write('harness-arena mcp server failed to start: ' + message + '\n');
  process.exit(1);
});
