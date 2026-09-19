import fsp from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ArenaContext } from '../context.js';
import { defaultExampleHarnessDir, inspectSource, readCloneUrl } from '../harnesses.js';
import { errorText, jsonResult } from '../result.js';

/** How many cached checkouts one call will inspect. */
export const HARNESS_CAP = 50;

const DESCRIPTION = [
  'Lists the harnesses available on this machine without fetching anything new: every harness Arena has',
  'already checked out under ARENA_HOME/harnesses (with the git URL it came from, its manifest name,',
  'framework, detected features and whether it declares commands that need trust), plus the example',
  'harness bundled with the repository when this server runs from a checkout. A local harness directory',
  'never appears here because Arena reads a local path in place and caches nothing; pass such a path to',
  'arena_inspect_harness instead. Nothing in this listing is executed or applied.',
].join(' ');

export function registerListHarnesses(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_list_harnesses',
    { title: 'List harnesses', description: DESCRIPTION, inputSchema: {} },
    async () => {
      const dir = path.join(ctx.home, 'harnesses');
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const inspected = dirs.slice(0, HARNESS_CAP);

      const cached: Array<Record<string, unknown>> = [];
      for (const key of inspected) {
        const full = path.join(dir, key);
        const entry: Record<string, unknown> = { cacheKey: key, path: full };
        entry.remote = await readCloneUrl(full);
        try {
          const outcome = await inspectSource({ source: full, env: ctx.env });
          entry.name = outcome.name;
          entry.framework = outcome.inspection.framework;
          entry.agents = outcome.inspection.agents;
          entry.manifest = {
            found: outcome.inspection.manifest.found,
            valid: outcome.inspection.manifest.valid,
            path: outcome.inspection.manifest.path,
            errors: outcome.inspection.manifest.errors,
          };
          entry.detectedFeatures = outcome.inspection.features.filter((f) => f.detected).map((f) => f.label);
          entry.compatibility = outcome.inspection.compatibility;
          entry.trustRequired = outcome.trustRequired;
          entry.execution = outcome.execution;
        } catch (err) {
          entry.error = errorText(err);
        }
        cached.push(entry);
      }

      const exampleDir =
        ctx.deps.exampleHarnessDir === undefined ? defaultExampleHarnessDir() : ctx.deps.exampleHarnessDir;
      let example: Record<string, unknown> | null = null;
      if (exampleDir !== null) {
        try {
          const outcome = await inspectSource({ source: exampleDir, env: ctx.env });
          example = {
            path: exampleDir,
            name: outcome.name,
            framework: outcome.inspection.framework,
            agents: outcome.inspection.agents,
            trustRequired: outcome.trustRequired,
            detectedFeatures: outcome.inspection.features.filter((f) => f.detected).map((f) => f.label),
            inspection: outcome.inspection,
          };
        } catch (err) {
          example = { path: exampleDir, error: errorText(err) };
        }
      }

      const truncatedNote =
        dirs.length > inspected.length
          ? ' (' + dirs.length + ' present, first ' + HARNESS_CAP + ' inspected)'
          : '';
      const exampleNote = example
        ? '; example harness at ' + exampleDir
        : '; no bundled example harness on this machine';
      const summary =
        cached.length + ' cached harness checkout(s) under ' + dir + truncatedNote + exampleNote + '.';

      return jsonResult(summary, {
        home: ctx.home,
        harnessesDir: dir,
        count: cached.length,
        totalPresent: dirs.length,
        truncated: dirs.length > inspected.length,
        cached,
        example,
      });
    },
  );
}
