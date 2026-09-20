import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ARENA_EXECUTION_NOTE,
  challengeResponseSchema,
  createChallengeRequestSchema,
} from '@harness-arena/protocol';
import type { ArenaContext } from '../context.js';
import { errorResult, errorText, issueText, jsonResult } from '../result.js';

/**
 * arena_create_challenge and arena_get_challenge.
 *
 * Both tools talk to an Arena SERVER; neither runs anything. Creating a challenge publishes a
 * definition, and the battle behind it is executed locally later by whoever accepts it, with
 * `arena challenge run <id>` in a terminal. Nothing here spends model budget, clones a repository or
 * reads a provider credential; the only secret involved is the device token from `arena login`, which
 * is read from ARENA_HOME/config.json, sent as a bearer header, and never returned or logged.
 */

const LOCAL_EXECUTION = [
  'Arena hosts no runner: the challenge is a definition, and the battle behind it is executed locally by',
  'whoever accepts it, on their own machine, with their own agent CLI and subscription, then uploaded.',
  'Creating a challenge here runs nothing and costs nothing. Tell the user to run',
  '`arena challenge run <id>` in a terminal to actually play it; every result is community-reported,',
  'never something Arena executed.',
].join(' ');

const CREATE_DESCRIPTION = [
  'Publishes a harness-vs-harness challenge on the Arena server this machine is logged in to: two',
  'harnesses (a GitHub URL, a local path, or the literal "vanilla" for agent defaults), one agent CLI',
  'both sides run, and the work — either an inline prompt with a repository, or a published benchmark',
  'pack version. Returns the challenge id and its URL.',
  LOCAL_EXECUTION,
  'Requires `arena login` to have been run in a terminal; without it this tool refuses and says so.',
].join(' ');

const GET_DESCRIPTION = [
  'Reads one challenge from the Arena server by id (chl_…): its definition, status, side A and side B,',
  'the agent, whether a decided result may move community ratings, and the ids of the battles uploaded',
  'against it. A private challenge is visible only to the account that created or accepted it.',
  LOCAL_EXECUTION,
].join(' ');

interface ServerConfig {
  serverUrl: string;
  token: string;
}

const NOT_LOGGED_IN =
  'not connected to an Arena server: run `arena login` in a terminal first, then retry. ' +
  'This tool never asks for or stores a credential itself.';

/** The device token `arena login` wrote. Returned only to the request builder, never to the client. */
async function serverConfig(ctx: ArenaContext): Promise<ServerConfig | null> {
  const config = await ctx.store.getConfig();
  const token = typeof config.token === 'string' && config.token.length > 0 ? config.token : null;
  const serverUrl =
    typeof config.serverUrl === 'string' && config.serverUrl.trim().length > 0
      ? config.serverUrl.trim().replace(/\/+$/, '')
      : null;
  if (!token || !serverUrl) return null;
  return { serverUrl, token };
}

async function call(
  ctx: ArenaContext,
  config: ServerConfig,
  path: string,
  init?: { method: string; body: unknown },
): Promise<{ status: number; json: unknown }> {
  const doFetch = ctx.deps.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: 'Bearer ' + config.token,
  };
  if (init) headers['content-type'] = 'application/json';
  const response = await doFetch(config.serverUrl + path, {
    ...(init ? { method: init.method, body: JSON.stringify(init.body) } : {}),
    headers,
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** An API error body, with nothing of the request echoed back. */
function serverMessage(status: number, json: unknown): string {
  const body = json as { error?: { message?: unknown } } | null;
  const message = body?.error?.message;
  return typeof message === 'string' ? message : 'HTTP ' + String(status);
}

export function registerChallengesTools(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_create_challenge',
    {
      title: 'Create a challenge',
      description: CREATE_DESCRIPTION,
      inputSchema: {
        title: z.string().min(1).max(200).describe('what this challenge is about'),
        harnessA: z.string().min(1).describe('side A harness: "vanilla", a GitHub URL, or a local path'),
        harnessB: z.string().min(1).describe('side B harness'),
        agentId: z
          .string()
          .min(1)
          .describe('the agent CLI both sides run: claude-code, codex, gemini-cli, opencode, fake'),
        prompt: z
          .string()
          .min(1)
          .max(50_000)
          .optional()
          .describe('the task both sides receive verbatim; pair it with repository'),
        repository: z
          .string()
          .min(1)
          .optional()
          .describe('repository the task is performed in: a GitHub URL, a path, or "empty"'),
        benchmarkSlug: z.string().min(1).optional().describe('published benchmark pack slug'),
        benchmarkVersionId: z
          .string()
          .min(1)
          .optional()
          .describe('the pack version id (bmv_…); required with benchmarkSlug'),
        visibility: z
          .enum(['private', 'unlisted', 'public'])
          .default('public')
          .describe('who can see the challenge'),
        ratingEligible: z
          .boolean()
          .default(true)
          .describe('may a decided result move community ratings (integrity checks still apply)'),
      },
    },
    async (args) => {
      const config = await serverConfig(ctx);
      if (!config) return errorResult(NOT_LOGGED_IN);

      const hasTask = args.prompt !== undefined && args.repository !== undefined;
      const hasBenchmark = args.benchmarkSlug !== undefined && args.benchmarkVersionId !== undefined;
      if (hasTask === hasBenchmark) {
        return errorResult(
          'give exactly one target: prompt together with repository, or benchmarkSlug together with benchmarkVersionId.',
        );
      }

      const target = hasBenchmark
        ? { kind: 'benchmark', slug: args.benchmarkSlug, versionId: args.benchmarkVersionId }
        : {
            kind: 'task',
            task: { kind: 'prompt', prompt: args.prompt },
            repository: { source: args.repository },
          };
      const parsed = createChallengeRequestSchema.safeParse({
        title: args.title,
        sides: { a: { harness: { source: args.harnessA } }, b: { harness: { source: args.harnessB } } },
        agent: { id: args.agentId },
        target,
        privacy: { upload: 'metrics' },
        visibility: args.visibility,
        ratingEligible: args.ratingEligible,
      });
      if (!parsed.success) {
        return errorResult('that challenge is not valid: ' + issueText(parsed.error.issues));
      }

      let result: { status: number; json: unknown };
      try {
        result = await call(ctx, config, '/api/v1/challenges', { method: 'POST', body: parsed.data });
      } catch (err) {
        return errorResult('could not reach ' + config.serverUrl + ': ' + errorText(err));
      }
      if (result.status === 401 || result.status === 403) {
        return errorResult(
          "the Arena server rejected this machine's device token. Run `arena login` again in a terminal.",
        );
      }
      if (result.status < 200 || result.status >= 300) {
        return errorResult('the server refused the challenge: ' + serverMessage(result.status, result.json));
      }
      const response = challengeResponseSchema.safeParse(result.json);
      if (!response.success) {
        return errorResult(config.serverUrl + ' returned an unexpected challenge response.');
      }

      const challenge = response.data.challenge;
      return jsonResult(
        'Created challenge ' +
          challenge.id +
          ' (' +
          challenge.status +
          '). Nothing has run: play it locally with `arena challenge run ' +
          challenge.id +
          '`.',
        {
          id: challenge.id,
          title: challenge.title,
          status: challenge.status,
          sides: challenge.sides,
          agent: challenge.agent,
          visibility: challenge.visibility,
          ratingEligible: challenge.ratingEligible,
          url: response.data.url,
          runLocallyWith: 'arena challenge run ' + challenge.id,
          note: ARENA_EXECUTION_NOTE,
        },
      );
    },
  );

  server.registerTool(
    'arena_get_challenge',
    {
      title: 'Get a challenge',
      description: GET_DESCRIPTION,
      inputSchema: { id: z.string().min(1).describe('challenge id, e.g. chl_7k2m9x4qv8b3n1d0') },
    },
    async ({ id }) => {
      const config = await serverConfig(ctx);
      if (!config) return errorResult(NOT_LOGGED_IN);

      let result: { status: number; json: unknown };
      try {
        result = await call(ctx, config, '/api/v1/challenges/' + encodeURIComponent(id));
      } catch (err) {
        return errorResult('could not reach ' + config.serverUrl + ': ' + errorText(err));
      }
      if (result.status === 404) {
        return errorResult('no challenge ' + id + ' is visible to this account on ' + config.serverUrl + '.');
      }
      if (result.status < 200 || result.status >= 300) {
        return errorResult(
          'could not read challenge ' + id + ': ' + serverMessage(result.status, result.json),
        );
      }
      const response = challengeResponseSchema.safeParse(result.json);
      if (!response.success) {
        return errorResult(config.serverUrl + ' returned an unexpected challenge response.');
      }

      const challenge = response.data.challenge;
      return jsonResult(
        'Challenge ' +
          challenge.id +
          ' is ' +
          challenge.status +
          ' with ' +
          String(challenge.battleIds.length) +
          ' linked battle(s).',
        {
          challenge,
          url: response.data.url,
          runLocallyWith: 'arena challenge run ' + challenge.id,
          note: ARENA_EXECUTION_NOTE,
        },
      );
    },
  );
}
