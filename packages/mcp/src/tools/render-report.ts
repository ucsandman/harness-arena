import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ARENA_VERSION, buildReportBundle, renderReportHtml } from '@harness-arena/core';
import type { ArenaContext } from '../context.js';
import { errorResult, errorText, jsonResult } from '../result.js';

/** Every report this tool writes carries this in its head; anything else is a file Arena did not write. */
const REPORT_MARKER = '<title>Harness Arena';
const MARKER_WINDOW = 4096;

/** True when the destination looks like a report, i.e. rewriting it destroys nothing of the user's. */
async function isArenaReport(file: string): Promise<boolean> {
  const handle = await fsp.open(file, 'r').catch(() => null);
  if (handle === null) return false;
  try {
    const buffer = Buffer.alloc(MARKER_WINDOW);
    const { bytesRead } = await handle.read(buffer, 0, MARKER_WINDOW, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').includes(REPORT_MARKER);
  } finally {
    await handle.close();
  }
}

/** Is `target` inside `root`? Keeps directory creation to ARENA_HOME, on both path flavours. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const DESCRIPTION = [
  'Writes the self-contained HTML battle report for one battle and returns the absolute path so the',
  'client can open it. The report embeds the record and the whole event timeline in one file: verdict,',
  'metric table with a status badge per value, insights, diffs and the per-run timelines. With no outPath',
  'it refreshes ARENA_HOME/battles/<id>/report.html; outPath may be a directory (report.html is written',
  'inside it) or a path ending in .html. A relative outPath resolves against the working directory of',
  "this server process, which is not the user's project, so prefer an absolute path. An existing",
  'destination is overwritten only when it is itself an Arena report, so a file the user wrote is never',
  'replaced; outside ARENA_HOME the parent directory must already exist. Nothing is uploaded and no',
  'network call is made.',
].join(' ');

export function registerRenderReport(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_render_report',
    {
      title: 'Render the battle report',
      description: DESCRIPTION,
      inputSchema: {
        id: z.string().min(1).describe('battle id, e.g. btl_3f9a1c2b (from arena_list_battles)'),
        outPath: z
          .string()
          .min(1)
          .optional()
          .describe('destination directory or .html file; defaults to the battle directory report.html'),
      },
    },
    async ({ id, outPath }) => {
      const record = await ctx.store.loadRecord(id).catch(() => null);
      if (record === null) {
        return errorResult(
          'no battle ' + id + ' under ' + ctx.home + '. Call arena_list_battles for the ids that exist.',
        );
      }

      let destination = ctx.store.paths(id).report;
      if (outPath !== undefined) {
        const resolved = path.resolve(outPath);
        const stat = await fsp.stat(resolved).catch(() => null);
        if (stat?.isDirectory()) {
          destination = path.join(resolved, 'report.html');
        } else if (/\.html?$/i.test(resolved)) {
          destination = resolved;
        } else {
          return errorResult(
            'outPath must be an existing directory or a path ending in .html; got ' + resolved + '.',
          );
        }

        const existing = await fsp.stat(destination).catch(() => null);
        if (existing !== null && (!existing.isFile() || !(await isArenaReport(destination)))) {
          return errorResult(
            destination +
              ' already exists and is not an Arena battle report, so nothing was written and the file ' +
              'is unchanged. Pass an outPath that does not exist yet, or delete that file yourself first.',
          );
        }
        if (existing === null && !isInside(ctx.home, destination)) {
          const parent = path.dirname(destination);
          const parentStat = await fsp.stat(parent).catch(() => null);
          if (parentStat === null || !parentStat.isDirectory()) {
            return errorResult(
              parent +
                ' does not exist. Outside ARENA_HOME (' +
                ctx.home +
                ') this tool writes only into a directory that already exists: create it yourself, or ' +
                'pass a path under ARENA_HOME.',
            );
          }
        }
      }

      const events = await ctx.store.readEvents(id);
      const html = renderReportHtml(buildReportBundle(record, events, ARENA_VERSION));
      try {
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.writeFile(destination, html, 'utf8');
      } catch (err) {
        return errorResult('could not write ' + destination + ': ' + errorText(err));
      }

      const bytes = Buffer.byteLength(html, 'utf8');
      const summary =
        'Wrote ' + Math.round(bytes / 1024) + ' KB of report for ' + id + ' to ' + destination + '.';
      return jsonResult(summary, {
        id,
        path: destination,
        bytes,
        events: events.length,
        arenaVersion: ARENA_VERSION,
        status: record.status,
        winner: record.verdict?.winner ?? null,
      });
    },
  );
}
