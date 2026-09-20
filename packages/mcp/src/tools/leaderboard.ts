import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RATING_CATEGORIES,
  harnessProfileResponseSchema,
  headToHeadSchema,
  leaderboardResponseSchema,
  ratingHistoryResponseSchema,
} from '@harness-arena/protocol';
import type { HarnessProfileResponse } from '@harness-arena/protocol';
import type { ArenaContext } from '../context.js';
import { errorResult, errorText, jsonResult } from '../result.js';

/**
 * The read tools: leaderboard, harness profile, rating (with its audit trail), head-to-head, insights.
 *
 * All five are GETs against an Arena server for public data, so none of them needs a login; the device
 * token is attached only when this machine already has one, and it is never returned. Nothing here
 * runs a battle or spends anything. When no server is configured the tool says so and returns an
 * error: it never answers a rating question from memory.
 */

const COMMUNITY_NOTE =
  'Results are community-reported: contributors ran those battles on their own machines with their own ' +
  'agent CLI and uploaded them. Arena executed none of them. The verified pool is Arena-executed and ' +
  'empty while no hosted runner exists. Rating math (Glicko-1, deviation, provisional thresholds) is ' +
  'documented at /docs/ratings on the server.';

const NO_SERVER =
  'no Arena server is configured for this machine: set ARENA_SERVER_URL, or run `arena login` in a ' +
  'terminal, which writes the server URL into ARENA_HOME/config.json. This tool never guesses a ' +
  'rating and never invents one.';

/** How many history rows one answer carries; the rest stay on the server. */
export const HISTORY_CAP = 100;

interface ServerAccess {
  serverUrl: string;
  /** attached when this machine is logged in, so a private harness of your own resolves; never returned */
  token: string | null;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * ARENA_SERVER_URL wins, then the serverUrl the CLI stored under ARENA_HOME. A token is a bonus, not
 * a requirement: these reads are public.
 */
async function serverAccess(ctx: ArenaContext): Promise<ServerAccess | null> {
  const config = await ctx.store.getConfig();
  const token = typeof config.token === 'string' && config.token.length > 0 ? config.token : null;
  const fromEnv = ctx.env.ARENA_SERVER_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { serverUrl: normalizeUrl(fromEnv), token };
  }
  const fromConfig = config.serverUrl;
  if (typeof fromConfig === 'string' && fromConfig.trim().length > 0) {
    return { serverUrl: normalizeUrl(fromConfig), token };
  }
  return null;
}

async function get(
  ctx: ArenaContext,
  access: ServerAccess,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const doFetch = ctx.deps.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (access.token) headers.authorization = 'Bearer ' + access.token;
  const response = await doFetch(access.serverUrl + path, { headers });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

function serverMessage(status: number, json: unknown): string {
  const body = json as { error?: { message?: unknown } } | null;
  const message = body?.error?.message;
  return typeof message === 'string' ? message : 'HTTP ' + String(status);
}

function query(pairs: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(pairs)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text.length > 0 ? '?' + text : '';
}

/** One read, with every failure turned into a sentence the caller can act on. */
async function read(
  ctx: ArenaContext,
  path: string,
  what: string,
): Promise<{ ok: true; access: ServerAccess; json: unknown } | { ok: false; message: string }> {
  const access = await serverAccess(ctx);
  if (!access) return { ok: false, message: NO_SERVER };
  let result: { status: number; json: unknown };
  try {
    result = await get(ctx, access, path);
  } catch (err) {
    return { ok: false, message: 'could not reach ' + access.serverUrl + ': ' + errorText(err) };
  }
  if (result.status === 404) {
    return { ok: false, message: 'no ' + what + ' on ' + access.serverUrl + '.' };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      message: 'could not read ' + what + ': ' + serverMessage(result.status, result.json),
    };
  }
  return { ok: true, access, json: result.json };
}

const categoryArg = z
  .enum(RATING_CATEGORIES)
  .optional()
  .describe('rating category; overall is the default');
const poolArg = z
  .enum(['community', 'verified'])
  .optional()
  .describe('community (self-reported local battles) or verified (Arena-executed, empty today)');

function profileOf(json: unknown, serverUrl: string): HarnessProfileResponse | string {
  const parsed = harnessProfileResponseSchema.safeParse(json);
  if (!parsed.success) return serverUrl + ' returned an unexpected harness profile response.';
  return parsed.data;
}

export function registerLeaderboardTools(server: McpServer, ctx: ArenaContext): void {
  server.registerTool(
    'arena_get_leaderboard',
    {
      title: 'Get the leaderboard',
      description: [
        'Ranked harnesses for one rating category and pool, read from the Arena server this machine is',
        'configured for. Each entry carries the rating, its deviation, the peak, the battle count, the',
        'win/loss/tie record and recent form; an entry below the minimum sample is flagged provisional',
        'and is listed but never ranked.',
        COMMUNITY_NOTE,
      ].join(' '),
      inputSchema: {
        category: categoryArg,
        pool: poolArg,
        agentId: z.string().min(1).optional().describe('only ratings earned under this agent CLI'),
        limit: z.number().int().min(1).max(200).optional().describe('how many entries to return'),
      },
    },
    async (args) => {
      const path =
        '/api/v1/leaderboard' +
        query({ category: args.category, pool: args.pool, agent: args.agentId, limit: args.limit });
      const result = await read(ctx, path, 'leaderboard');
      if (!result.ok) return errorResult(result.message);
      const parsed = leaderboardResponseSchema.safeParse(result.json);
      if (!parsed.success) {
        return errorResult(result.access.serverUrl + ' returned an unexpected leaderboard response.');
      }
      const board = parsed.data;
      const ranked = board.entries.filter((entry) => !entry.provisional);
      return jsonResult(
        board.poolEmpty
          ? 'The ' +
              board.pool +
              ' pool holds no ratings at all' +
              (board.pool === 'verified' ? ': Arena hosts no runner, so nothing has been verified.' : '.')
          : String(ranked.length) +
              ' ranked and ' +
              String(board.entries.length - ranked.length) +
              ' provisional entries in ' +
              board.category +
              ' (' +
              board.pool +
              ').',
        {
          server: result.access.serverUrl,
          category: board.category,
          pool: board.pool,
          agentId: board.agentId,
          minSample: board.minSample,
          poolEmpty: board.poolEmpty,
          ranked: ranked.length,
          provisional: board.entries.length - ranked.length,
          entries: board.entries,
          note: COMMUNITY_NOTE,
        },
      );
    },
  );

  server.registerTool(
    'arena_get_harness_profile',
    {
      title: 'Get a harness profile',
      description: [
        'Everything the Arena server holds about one harness by slug: identity and source, every',
        '(agent, category, pool) rating, per-category performance with its sample, the median token,',
        'cost and duration ratios against its opponents, the commits that were tested, who it has',
        'fought, declared lineage, and the deterministic insights with the sample each rests on.',
        COMMUNITY_NOTE,
      ].join(' '),
      inputSchema: { slug: z.string().min(1).describe('harness slug as the server catalogues it') },
    },
    async ({ slug }) => {
      const result = await read(
        ctx,
        '/api/v1/harnesses/' + encodeURIComponent(slug),
        'harness ' + slug,
      );
      if (!result.ok) return errorResult(result.message);
      const profile = profileOf(result.json, result.access.serverUrl);
      if (typeof profile === 'string') return errorResult(profile);
      return jsonResult(
        profile.name +
          ' (' +
          profile.slug +
          '): ' +
          String(profile.ratings.length) +
          ' rating rows over ' +
          String(profile.analyzedBattles) +
          ' decided public battles.',
        {
          server: result.access.serverUrl,
          profile,
          url: result.access.serverUrl + '/harnesses/' + profile.slug,
          note: COMMUNITY_NOTE,
        },
      );
    },
  );

  server.registerTool(
    'arena_get_rating',
    {
      title: 'Get a harness rating',
      description: [
        'One harness rating for an agent, category and pool: the current number with its deviation, the',
        'peak, the battle count, the win/loss/tie record, recent form and whether it is provisional.',
        'With history: true it also returns the rating events behind it, each with the battle id, the',
        'opponent, the outcome and the before and after numbers, so the figure can be audited row by row.',
        COMMUNITY_NOTE,
      ].join(' '),
      inputSchema: {
        slug: z.string().min(1).describe('harness slug as the server catalogues it'),
        agentId: z.string().min(1).optional().describe('the agent CLI the rating was earned under'),
        category: categoryArg,
        pool: poolArg,
        history: z
          .boolean()
          .default(false)
          .describe('also return the rating events behind the number (capped at ' + HISTORY_CAP + ')'),
      },
    },
    async (args) => {
      const category = args.category ?? 'overall';
      const pool = args.pool ?? 'community';
      const result = await read(
        ctx,
        '/api/v1/harnesses/' + encodeURIComponent(args.slug),
        'harness ' + args.slug,
      );
      if (!result.ok) return errorResult(result.message);
      const profile = profileOf(result.json, result.access.serverUrl);
      if (typeof profile === 'string') return errorResult(profile);

      const ratings = profile.ratings.filter(
        (rating) =>
          rating.category === category &&
          rating.pool === pool &&
          (args.agentId === undefined || rating.agentId === args.agentId),
      );
      if (ratings.length === 0) {
        return errorResult(
          profile.slug +
            ' has no ' +
            pool +
            ' rating for ' +
            category +
            (args.agentId ? ' on agent ' + args.agentId : '') +
            '. Use arena_get_harness_profile to see which rating rows exist.',
        );
      }

      let points: unknown[] = [];
      let truncated = false;
      if (args.history) {
        const agentId = args.agentId ?? ratings[0]?.agentId;
        const historyResult = await read(
          ctx,
          '/api/v1/harnesses/' +
            encodeURIComponent(profile.slug) +
            '/history' +
            query({ category, pool, agent: agentId }),
          'the rating history of ' + profile.slug,
        );
        if (!historyResult.ok) return errorResult(historyResult.message);
        const parsed = ratingHistoryResponseSchema.safeParse(historyResult.json);
        if (!parsed.success) {
          return errorResult(result.access.serverUrl + ' returned an unexpected rating history response.');
        }
        truncated = parsed.data.points.length > HISTORY_CAP;
        points = parsed.data.points.slice(-HISTORY_CAP);
      }

      const first = ratings[0];
      return jsonResult(
        profile.slug +
          ': ' +
          String(Math.round(first?.rating ?? 0)) +
          ' +/-' +
          String(Math.round(first?.deviation ?? 0)) +
          ' in ' +
          category +
          ' (' +
          pool +
          ', ' +
          String(ratings.length) +
          ' agent row(s))' +
          (first?.provisional ? ', provisional' : ''),
        {
          server: result.access.serverUrl,
          slug: profile.slug,
          name: profile.name,
          category,
          pool,
          ratings,
          ...(args.history ? { history: points, historyTruncated: truncated } : {}),
          note: COMMUNITY_NOTE,
        },
      );
    },
  );

  server.registerTool(
    'arena_get_head_to_head',
    {
      title: 'Get a head-to-head record',
      description: [
        'The record between two harnesses on the Arena server: wins, losses, ties, inconclusive battles,',
        'the win rate over the decided ones, the last battle and the ids of the most recent battles, all',
        'under the filters given (agent, category, pool). The filters that produced the numbers come back',
        'with them.',
        COMMUNITY_NOTE,
      ].join(' '),
      inputSchema: {
        slug: z.string().min(1).describe('the harness you are asking about'),
        opponent: z.string().min(1).describe('the opponent harness slug'),
        agentId: z.string().min(1).optional().describe('only battles run under this agent CLI'),
        category: categoryArg,
        pool: poolArg,
      },
    },
    async (args) => {
      const path =
        '/api/v1/harnesses/' +
        encodeURIComponent(args.slug) +
        '/vs/' +
        encodeURIComponent(args.opponent) +
        query({ agent: args.agentId, category: args.category, pool: args.pool });
      const result = await read(ctx, path, args.slug + ' against ' + args.opponent);
      if (!result.ok) return errorResult(result.message);
      // The route may wrap the record or return it bare; both parse.
      const body = result.json as { headToHead?: unknown } | null;
      const parsed = headToHeadSchema.safeParse(body?.headToHead ?? result.json);
      if (!parsed.success) {
        return errorResult(result.access.serverUrl + ' returned an unexpected head-to-head response.');
      }
      const h2h = parsed.data;
      return jsonResult(
        h2h.subject.slug +
          ' vs ' +
          h2h.opponent.slug +
          ': ' +
          String(h2h.wins) +
          'W ' +
          String(h2h.losses) +
          'L ' +
          String(h2h.ties) +
          'T over ' +
          String(h2h.battles) +
          ' decided battles.',
        { server: result.access.serverUrl, headToHead: h2h, note: COMMUNITY_NOTE },
      );
    },
  );

  server.registerTool(
    'arena_get_insights',
    {
      title: 'Get harness insights',
      description: [
        'The deterministic insights the Arena server derived for one harness: category strengths and',
        'weaknesses, differences between versions, and efficiency against its opponents. Every insight',
        'carries the number of battles it rests on (n), and nothing is generated by a model; below the',
        'sample thresholds the list is simply empty.',
        COMMUNITY_NOTE,
      ].join(' '),
      inputSchema: { slug: z.string().min(1).describe('harness slug as the server catalogues it') },
    },
    async ({ slug }) => {
      const result = await read(
        ctx,
        '/api/v1/harnesses/' + encodeURIComponent(slug),
        'harness ' + slug,
      );
      if (!result.ok) return errorResult(result.message);
      const profile = profileOf(result.json, result.access.serverUrl);
      if (typeof profile === 'string') return errorResult(profile);
      return jsonResult(
        profile.insights.length === 0
          ? profile.slug +
              ' has no insights yet: ' +
              String(profile.analyzedBattles) +
              ' decided battles is under the sample thresholds.'
          : String(profile.insights.length) +
              ' insight(s) for ' +
              profile.slug +
              ' over ' +
              String(profile.analyzedBattles) +
              ' decided battles.',
        {
          server: result.access.serverUrl,
          slug: profile.slug,
          name: profile.name,
          analyzedBattles: profile.analyzedBattles,
          insights: profile.insights,
          efficiencyProfile: profile.efficiencyProfile,
          categoryPerformance: profile.categoryPerformance,
          note: COMMUNITY_NOTE,
        },
      );
    },
  );
}
