import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ArenaContext } from '../context.js';
import { inspectSource } from '../harnesses.js';
import { errorResult, errorText, jsonResult } from '../result.js';

const DESCRIPTION = [
  'Inspects a harness without running any of it. Accepts a local directory path, a github.com URL',
  '(optionally with a /tree/<ref>/<subdir> suffix) or the literal "vanilla" for agent defaults. A local',
  'path is walked on disk; a GitHub harness is read through the REST API, so nothing is cloned, copied,',
  'installed or executed. The report names the framework and the agent ids the harness supports, the',
  'arena.yaml manifest with any validation errors, the detected features (CLAUDE.md, settings, hooks,',
  'skills, subagents, commands, MCP, AGENTS.md, Codex/Gemini/OpenCode config, Cursor rules), the files',
  'that would be copied into a battle workspace, the install/prepare commands it declares, and a',
  'compatibility verdict. When trustRequired is true, a battle using this harness needs trust: true in',
  'arena_start_battle; show the caller the exact commands in execution.commands first.',
].join(' ');

export function registerInspectHarness(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_inspect_harness',
    {
      title: 'Inspect a harness',
      description: DESCRIPTION,
      inputSchema: {
        source: z
          .string()
          .min(1)
          .describe('local directory path, a github.com URL, or "vanilla" for agent defaults'),
        ref: z.string().min(1).optional().describe('branch, tag or commit; GitHub sources only'),
      },
    },
    async ({ source, ref }) => {
      let outcome;
      try {
        outcome = await inspectSource({
          source,
          ref: ref ?? null,
          env: ctx.env,
          fetchImpl: ctx.deps.fetchImpl,
        });
      } catch (err) {
        return errorResult('could not inspect ' + source + ': ' + errorText(err));
      }

      const detected = outcome.inspection.features.filter((f) => f.detected).map((f) => f.label);
      const summary =
        outcome.name +
        ' (' +
        outcome.mode +
        ', framework ' +
        outcome.inspection.framework +
        ', ' +
        outcome.inspection.fileCount +
        ' files' +
        (outcome.inspection.truncated ? ', listing truncated' : '') +
        '): ' +
        (detected.length > 0 ? detected.join(', ') : 'no harness features detected') +
        '. ' +
        (outcome.trustRequired
          ? 'Needs trust: it declares ' + outcome.execution.commands.length + ' command(s).'
          : 'No commands declared, so no trust prompt.');

      return jsonResult(summary, {
        name: outcome.name,
        mode: outcome.mode,
        ref: outcome.ref,
        source: outcome.source,
        trustRequired: outcome.trustRequired,
        execution: outcome.execution,
        detectedFeatures: detected,
        inspection: outcome.inspection,
      });
    },
  );
}
