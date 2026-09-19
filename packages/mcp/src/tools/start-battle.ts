import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runBattle } from '@harness-arena/core';
import { battleSpecSchema } from '@harness-arena/protocol';
import type { BattleSpec } from '@harness-arena/protocol';
import type { ArenaContext } from '../context.js';
import { errorResult, errorText, issueText, jsonResult } from '../result.js';

const DESCRIPTION = [
  'Starts a battle from a battle spec and returns as soon as the battle has an id, so the client polls',
  'arena_get_battle for progress instead of blocking. Give either spec (the spec object itself, schema',
  'battleSpecSchema: version 1, task, repository, competitors.a and competitors.b, optional limits,',
  'evaluation, privacy) or specPath (a path to a JSON spec file such as examples/battles/fake-quick.json),',
  'never both. The spec is validated before anything runs and an invalid spec is reported field by field.',
  'One battle runs per server process: a second start is refused and names the battle already running.',
  'Trust is explicit and per call: with trust false (the default) a harness that declares install or',
  'prepare commands is refused and the battle fails with the exact commands in its error, having executed',
  'nothing; pass trust true only after showing the user those commands (arena_inspect_harness lists them).',
  'A competitors.<side>.harness.trusted field inside the spec is a client assertion and is ignored: only',
  'the trust argument of this call can approve a command.',
  "Arena runs the user's own authenticated agent CLIs on this machine, pays no model costs and reads no",
  'provider credentials; a spec using agent id "fake" replays fixtures and costs nothing. waitMs lets the',
  'call wait for completion (default 0, i.e. do not wait) when the battle is expected to be quick.',
].join(' ');

export function registerStartBattle(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_start_battle',
    {
      title: 'Start a battle',
      description: DESCRIPTION,
      inputSchema: {
        spec: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('the battle spec object (battleSpecSchema); mutually exclusive with specPath'),
        specPath: z
          .string()
          .min(1)
          .optional()
          .describe('path to a JSON battle spec file; mutually exclusive with spec'),
        trust: z
          .boolean()
          .default(false)
          .describe('approve the install/prepare commands the harnesses declare; false refuses to run them'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .default(0)
          .describe('wait up to this many ms for the battle to finish before answering (default 0)'),
      },
    },
    async ({ spec, specPath, trust, waitMs }) => {
      if ((spec === undefined) === (specPath === undefined)) {
        return errorResult('give exactly one of spec (an object) or specPath (a path to a JSON file).');
      }

      let raw: unknown = spec;
      if (specPath !== undefined) {
        const file = path.resolve(specPath);
        let text: string;
        try {
          text = await fsp.readFile(file, 'utf8');
        } catch (err) {
          return errorResult('could not read the spec file ' + file + ': ' + errorText(err));
        }
        try {
          raw = JSON.parse(text);
        } catch (err) {
          return errorResult(file + ' is not valid JSON: ' + errorText(err));
        }
      }

      const parsed = battleSpecSchema.safeParse(raw);
      if (!parsed.success) {
        return errorResult('invalid battle spec: ' + issueText(parsed.error.issues));
      }
      const validated: BattleSpec = parsed.data;
      // Trust is per call here (README "Trust model"): a spec can assert harness.trusted, which core
      // honours as consent, so it is cleared at this boundary and the callback below is the only
      // channel that can approve a harness command.
      validated.competitors.a.harness.trusted = false;
      validated.competitors.b.harness.trusted = false;

      if (ctx.runner.busy) {
        return errorResult(
          'battle ' +
            (ctx.runner.runningId ?? 'unknown') +
            ' is already running in this server; one battle runs at a time. Poll it with arena_get_battle ' +
            'and start the next one when it is done.',
        );
      }

      const run = ctx.deps.runBattle ?? runBattle;
      const refusals: string[] = [];
      const startedAt = Date.now();

      const outcome = await ctx.runner.start({
        trusted: trust,
        waitMs,
        run: (hooks) =>
          run(validated, {
            home: ctx.home,
            registry: ctx.registry,
            logger: ctx.logger,
            signal: ctx.signal,
            onEvent: hooks.onEvent,
            onStatus: hooks.onStatus,
            trust: async (harness, exec) => {
              if (!trust) {
                refusals.push(harness.name + ': ' + exec.commands.join(' && '));
                ctx.logger.warn('refused harness commands: trust was not granted for this call', {
                  harness: harness.name,
                  commands: exec.commands.length,
                });
                return false;
              }
              ctx.logger.info('harness commands approved by the caller', {
                harness: harness.name,
                commands: exec.commands.length,
              });
              return true;
            },
          }),
      });

      if (outcome.kind === 'busy') {
        return errorResult(
          'battle ' +
            (outcome.runningId ?? 'unknown') +
            ' is already running in this server; one battle runs at a time.',
        );
      }
      if (outcome.kind === 'failed') {
        return errorResult('the battle could not start: ' + outcome.message);
      }

      const handle = outcome.handle;
      const record = outcome.finished ? await ctx.store.loadRecord(handle.id).catch(() => null) : null;
      const status = record?.status ?? handle.status;

      const summary =
        'Battle ' +
        handle.id +
        ' is ' +
        status +
        (outcome.finished ? '' : '; poll arena_get_battle with this id') +
        (record?.verdict ? '. Winner: ' + record.verdict.winner : '') +
        (refusals.length > 0 ? '. Harness commands were refused because trust was false.' : '') +
        '.';

      return jsonResult(summary, {
        id: handle.id,
        status,
        trusted: trust,
        finished: outcome.finished,
        waitedMs: Date.now() - startedAt,
        winner: record?.verdict?.winner ?? null,
        error: record?.error ?? handle.error,
        refusedHarnessCommands: refusals,
        pollWith: 'arena_get_battle',
      });
    },
  );
}
