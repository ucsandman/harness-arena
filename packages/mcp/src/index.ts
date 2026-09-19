/**
 * @harness-arena/mcp — the MCP interface into Harness Arena.
 *
 * An interface, never the execution architecture: every tool delegates to @harness-arena/core,
 * @harness-arena/adapters and @harness-arena/harness. Embed it with createArenaMcpServer and connect
 * it to any transport, or run the bundled `harness-arena-mcp` binary over stdio.
 */

export { createArenaMcpServer, TOOL_NAMES } from './server.js';
export type { ArenaMcpServer, ArenaMcpServerOptions } from './server.js';
export type { ArenaContext, ArenaMcpDeps } from './context.js';
export { BattleRunner } from './runner.js';
export type { BattleHandle, RunHooks, StartInput, StartResult } from './runner.js';
export { EVENT_CAP, EVENT_DEFAULT_LIMIT, HARNESS_CAP, registerTools } from './tools/index.js';
export type { ToolName } from './tools/index.js';
export { defaultExampleHarnessDir, inspectSource, readCloneUrl } from './harnesses.js';
export type { InspectOutcome, InspectSourceOptions } from './harnesses.js';
export { metricCell } from './format.js';
export type { MetricCell } from './format.js';
export { errorResult, errorText, issueText, jsonResult, MAX_JSON_BYTES } from './result.js';
