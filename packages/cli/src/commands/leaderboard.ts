import type { Command } from 'commander';
import {
  BADGE_KIND_LABELS,
  RATING_CATEGORY_LABELS,
  RATING_POOL_LABELS,
  badgeKindSchema,
  harnessProfileResponseSchema,
  headToHeadSchema,
  leaderboardResponseSchema,
  ratingCategorySchema,
  ratingHistoryResponseSchema,
  ratingPoolSchema,
} from '@harness-arena/protocol';
import type {
  BadgeKind,
  HarnessProfileResponse,
  HarnessRating,
  LeaderboardEntry,
  LeaderboardResponse,
  RatingCategory,
  RatingHistoryResponse,
  RatingPool,
} from '@harness-arena/protocol';
import type { CliDeps } from '../deps.js';
import { createUi, shortDate, supportsUnicode } from '../ui.js';
import type { Ui } from '../ui.js';
import { CliError } from '../errors.js';
import { serverError } from './login.js';
import { readJson, serverAccess } from './challenge.js';
import type { ServerAccess } from './challenge.js';

/**
 * The read side: `arena leaderboard`, `arena rating`, `arena profile`, `arena h2h`, `arena badge`.
 *
 * All five read public data, so none of them needs a login; the device token is attached when this
 * machine happens to have one (that is what `readJson` does), which is the only way a private harness
 * of your own shows up. Nothing here runs a battle, and every number printed travels with the sample
 * it was computed over: a rate with no denominator is not printed at all.
 *
 * Ratings are Glicko-1 over decided battles, documented at /docs/ratings and in docs/RATINGS.md. The
 * community pool is self-reported: contributors ran those battles on their own machines. The verified
 * pool is Arena-executed and, while no hosted runner exists, empty - and says so instead of rendering
 * an empty table as if it were a result.
 */

export interface LeaderboardFlags {
  category?: string;
  pool?: string;
  agent?: string;
  limit?: string;
  history?: boolean;
  kind?: string;
  markdown?: boolean;
  benchmark?: string;
  commit?: string;
  since?: string;
  until?: string;
  json?: boolean;
  home?: string;
  server?: string;
}

const RATINGS_DOC = '/docs/ratings';

const COMMUNITY_NOTE =
  'Community ratings come from battles contributors ran on their own machines and uploaded. ' +
  'Arena executed none of them.';

const VERIFIED_EMPTY_NOTE =
  'The verified pool is empty. Arena hosts no runner yet, so no battle has been executed under ' +
  'verified conditions; nothing is ranked here until one is.';

// ---- flag parsing -------------------------------------------------------------------------------

function parseCategory(value: string): RatingCategory {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const parsed = ratingCategorySchema.safeParse(normalized);
  if (!parsed.success) {
    throw new CliError('--category must be one of: ' + ratingCategorySchema.options.join(', '));
  }
  return parsed.data;
}

function parsePool(value: string): RatingPool {
  const parsed = ratingPoolSchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) throw new CliError('--pool must be community or verified.');
  return parsed.data;
}

function parseBadgeKind(value: string): BadgeKind {
  const parsed = badgeKindSchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) {
    throw new CliError('--kind must be one of: ' + badgeKindSchema.options.join(', '));
  }
  return parsed.data;
}

function parseLimit(value: string): string {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new CliError('--limit must be a positive whole number.');
  return String(n);
}

// ---- formatting ---------------------------------------------------------------------------------

/** `1524 ±88`, or `1524 +/-88` where the console cannot draw the glyph. */
function ratingText(deps: CliDeps, rating: number, deviation: number): string {
  const pm = supportsUnicode(deps) ? '±' : '+/-';
  return String(Math.round(rating)) + ' ' + pm + String(Math.round(deviation));
}

function recordText(r: { wins: number; losses: number; ties: number }): string {
  return String(r.wins) + '/' + String(r.losses) + '/' + String(r.ties);
}

/** A share never prints without the sample under it: `58% of 24` or `n/a (0 decided battles)`. */
function rateText(part: number, total: number): string {
  if (total === 0) return 'n/a (0 decided battles)';
  return String(Math.round((part / total) * 100)) + '% of ' + String(total);
}

function decided(r: { wins: number; losses: number; ties: number }): number {
  return r.wins + r.losses + r.ties;
}

function formText(form: string): string {
  return form.length > 0 ? form : '-';
}

function leaderboardRow(deps: CliDeps, entry: LeaderboardEntry, minSample: number): string[] {
  return [
    entry.rank === null ? '-' : String(entry.rank),
    entry.harnessSlug,
    entry.agentId,
    ratingText(deps, entry.rating, entry.deviation),
    String(Math.round(entry.peakRating)),
    String(entry.battles),
    recordText(entry),
    formText(entry.form),
    String(decided(entry)) + '/' + String(minSample),
  ];
}

const LEADERBOARD_HEAD = [
  'Rank',
  'Harness',
  'Agent',
  'Rating',
  'Peak',
  'Battles',
  'W/L/T',
  'Form',
  'Sample',
];

// ---- server reads -------------------------------------------------------------------------------

function querySuffix(query: URLSearchParams): string {
  const text = query.toString();
  return text.length > 0 ? '?' + text : '';
}

/** A GET whose non-2xx becomes the server's own message with exit code 1. */
async function readOrThrow(
  deps: CliDeps,
  access: ServerAccess,
  path: string,
  what: string,
): Promise<unknown> {
  const result = await readJson(deps, access, path);
  if (result.status === 404) {
    throw new CliError('nothing at ' + access.serverUrl + path + ': ' + what + ' is not there.');
  }
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not read ' + what + ' from ' + access.serverUrl);
  }
  return result.json;
}

async function fetchProfile(
  deps: CliDeps,
  access: ServerAccess,
  slug: string,
): Promise<HarnessProfileResponse> {
  const json = await readOrThrow(
    deps,
    access,
    '/api/v1/harnesses/' + encodeURIComponent(slug),
    'harness ' + slug,
  );
  const parsed = harnessProfileResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      access.serverUrl + ' returned an unexpected harness profile; is it a Harness Arena server?',
    );
  }
  return parsed.data;
}

// ---- arena leaderboard --------------------------------------------------------------------------

async function leaderboardCommand(deps: CliDeps, flags: LeaderboardFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);

  const query = new URLSearchParams();
  if (flags.category) query.set('category', parseCategory(flags.category));
  if (flags.pool) query.set('pool', parsePool(flags.pool));
  if (flags.agent) query.set('agent', flags.agent);
  if (flags.limit) query.set('limit', parseLimit(flags.limit));

  const json = await readOrThrow(
    deps,
    access,
    '/api/v1/leaderboard' + querySuffix(query),
    'the leaderboard',
  );
  const parsed = leaderboardResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      access.serverUrl + ' returned an unexpected leaderboard response; is it a Harness Arena server?',
    );
  }
  const board: LeaderboardResponse = parsed.data;
  const ranked = board.entries.filter((entry) => !entry.provisional);
  const provisional = board.entries.filter((entry) => entry.provisional);

  if (ui.json) {
    ui.emitJson({
      server: access.serverUrl,
      category: board.category,
      pool: board.pool,
      agentId: board.agentId,
      minSample: board.minSample,
      poolEmpty: board.poolEmpty,
      ranked: ranked.length,
      provisional: provisional.length,
      entries: board.entries,
      note: board.pool === 'community' ? COMMUNITY_NOTE : VERIFIED_EMPTY_NOTE,
    });
    return;
  }

  ui.line(
    ui.c.bold(
      RATING_CATEGORY_LABELS[board.category] + ' - ' + RATING_POOL_LABELS[board.pool] + ' pool',
    ) + (board.agentId ? ui.c.dim('  agent ' + board.agentId) : ''),
  );
  if (board.poolEmpty) {
    ui.line();
    ui.line(
      board.pool === 'verified'
        ? VERIFIED_EMPTY_NOTE
        : 'No community ratings on ' +
            access.serverUrl +
            ' yet: a rating appears once a public battle with a decided winner is uploaded.',
    );
    return;
  }

  ui.line();
  if (ranked.length > 0) {
    ui.table(
      ranked.map((entry) => leaderboardRow(deps, entry, board.minSample)),
      LEADERBOARD_HEAD,
    );
  } else {
    ui.line('  No ranked ratings yet in this category and pool.');
  }

  if (provisional.length > 0) {
    ui.line();
    ui.line(
      ui.c.dim(
        '-- provisional: fewer than ' +
          String(board.minSample) +
          ' decided battles, or a deviation too wide to order. Listed, never ranked. --',
      ),
    );
    ui.table(provisional.map((entry) => leaderboardRow(deps, entry, board.minSample)));
  }

  ui.line();
  ui.line(ui.c.dim(board.pool === 'community' ? COMMUNITY_NOTE : VERIFIED_EMPTY_NOTE));
  ui.line(ui.c.dim('How a rating is computed: ' + access.serverUrl + RATINGS_DOC));
}

// ---- arena rating -------------------------------------------------------------------------------

function selectRatings(
  profile: HarnessProfileResponse,
  category: RatingCategory,
  pool: RatingPool,
  agentId: string | undefined,
): HarnessRating[] {
  return profile.ratings.filter(
    (rating) =>
      rating.category === category &&
      rating.pool === pool &&
      (agentId === undefined || rating.agentId === agentId),
  );
}

function noRatingError(
  profile: HarnessProfileResponse,
  category: RatingCategory,
  pool: RatingPool,
  agentId: string | undefined,
): CliError {
  const known = profile.ratings
    .map((rating) => rating.agentId + '/' + rating.category + '/' + rating.pool)
    .join(', ');
  return new CliError(
    profile.slug +
      ' has no ' +
      pool +
      ' rating for ' +
      category +
      (agentId ? ' on agent ' + agentId : '') +
      '. ' +
      (known.length > 0 ? 'It does have: ' + known + '.' : 'It has no rating at all yet.'),
  );
}

async function fetchHistory(
  deps: CliDeps,
  access: ServerAccess,
  slug: string,
  category: RatingCategory,
  pool: RatingPool,
  agentId: string | undefined,
): Promise<RatingHistoryResponse> {
  const query = new URLSearchParams({ category, pool });
  if (agentId) query.set('agent', agentId);
  const json = await readOrThrow(
    deps,
    access,
    '/api/v1/harnesses/' + encodeURIComponent(slug) + '/history' + querySuffix(query),
    'the rating history of ' + slug,
  );
  const parsed = ratingHistoryResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(access.serverUrl + ' returned an unexpected rating history response.');
  }
  return parsed.data;
}

async function ratingCommand(deps: CliDeps, slug: string, flags: LeaderboardFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);
  const category = flags.category ? parseCategory(flags.category) : 'overall';
  const pool = flags.pool ? parsePool(flags.pool) : 'community';

  const profile = await fetchProfile(deps, access, slug);
  const ratings = selectRatings(profile, category, pool, flags.agent);
  if (ratings.length === 0) throw noRatingError(profile, category, pool, flags.agent);

  const history = flags.history
    ? await fetchHistory(deps, access, profile.slug, category, pool, flags.agent ?? ratings[0]?.agentId)
    : null;

  if (ui.json) {
    ui.emitJson({
      server: access.serverUrl,
      slug: profile.slug,
      name: profile.name,
      category,
      pool,
      ratings,
      ...(history ? { history: history.points } : {}),
      note: pool === 'community' ? COMMUNITY_NOTE : VERIFIED_EMPTY_NOTE,
    });
    return;
  }

  ui.line(ui.c.bold(profile.name) + ui.c.dim('  ' + profile.slug));
  ui.detail('Category', RATING_CATEGORY_LABELS[category]);
  ui.detail('Pool', RATING_POOL_LABELS[pool]);
  for (const rating of ratings) {
    const n = decided(rating);
    ui.heading('Agent ' + rating.agentId);
    ui.detail('Rating', ratingText(deps, rating.rating, rating.deviation));
    ui.detail('Peak', String(Math.round(rating.peakRating)));
    ui.detail('Deviation', String(Math.round(rating.deviation)));
    ui.detail('Battles', String(rating.battles) + ' (' + String(n) + ' decided)');
    ui.detail('W/L/T', recordText(rating));
    ui.detail('Win rate', rateText(rating.wins, n));
    ui.detail('Tie rate', rateText(rating.ties, n));
    ui.detail('Form', formText(rating.form));
    ui.detail('Last battle', rating.lastBattleAt ? shortDate(rating.lastBattleAt) : 'never');
    if (rating.provisional) ui.detail('Provisional', 'yes: listed, never ranked');
  }

  if (history) {
    ui.heading('History');
    if (history.points.length === 0) {
      ui.line('  No rating events for this agent, category and pool.');
    } else {
      ui.table(
        history.points.map((point) => [
          point.battleId,
          shortDate(point.at),
          point.opponentSlug ?? 'unknown',
          point.outcome,
          String(Math.round(point.rating - point.delta)),
          String(Math.round(point.rating)),
          (point.delta >= 0 ? '+' : '') + String(Math.round(point.delta)),
        ]),
        ['Battle', 'When', 'Opponent', 'Outcome', 'Before', 'After', 'Delta'],
      );
    }
  }

  ui.line();
  ui.line(ui.c.dim(pool === 'community' ? COMMUNITY_NOTE : VERIFIED_EMPTY_NOTE));
}

// ---- arena profile ------------------------------------------------------------------------------

function printEfficiency(ui: Ui, profile: HarnessProfileResponse): void {
  const rows: string[][] = [];
  const add = (label: string, ratio: { medianRatio: number | null; n: number }): void => {
    if (ratio.medianRatio === null) {
      rows.push([label, 'n/a', String(ratio.n)]);
      return;
    }
    rows.push([label, ratio.medianRatio.toFixed(2) + 'x', String(ratio.n)]);
  };
  add('Tokens', profile.efficiencyProfile.tokens);
  add('Cost', profile.efficiencyProfile.cost);
  add('Duration', profile.efficiencyProfile.duration);
  ui.table(rows, ['Metric', 'Median vs opponent', 'Battles']);
}

async function profileCommand(deps: CliDeps, slug: string, flags: LeaderboardFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);
  const profile = await fetchProfile(deps, access, slug);

  if (ui.json) {
    ui.emitJson({
      server: access.serverUrl,
      profile,
      url: access.serverUrl + '/harnesses/' + profile.slug,
      note: COMMUNITY_NOTE,
    });
    return;
  }

  ui.line(ui.c.bold(profile.name) + ui.c.dim('  ' + profile.slug));
  if (profile.description) ui.line(profile.description);
  ui.detail('Source', profile.sourceUrl ?? profile.sourceKind);
  ui.detail('Framework', profile.framework);
  ui.detail('Imported by', profile.owner ?? 'nobody (catalogued without an owner)');
  ui.detail('Analyzed', String(profile.analyzedBattles) + ' decided public battles');
  ui.detail('Challenges', String(profile.challenges));
  ui.detail('Web', access.serverUrl + '/harnesses/' + profile.slug);

  ui.heading('Ratings');
  if (profile.ratings.length === 0) {
    ui.line('  No rating yet: no decided public battle has counted for this harness.');
  } else {
    ui.table(
      profile.ratings.map((rating) => [
        rating.agentId,
        rating.category,
        rating.pool,
        ratingText(deps, rating.rating, rating.deviation),
        String(Math.round(rating.peakRating)),
        recordText(rating),
        formText(rating.form),
        rating.provisional ? 'provisional' : 'ranked',
      ]),
      ['Agent', 'Category', 'Pool', 'Rating', 'Peak', 'W/L/T', 'Form', 'Status'],
    );
  }

  ui.heading('Categories');
  if (profile.categoryPerformance.length === 0) {
    ui.line('  Nothing measured yet.');
  } else {
    ui.table(
      profile.categoryPerformance.map((entry) => [
        entry.category,
        String(entry.battles),
        recordText(entry),
        entry.correctnessRate === null
          ? 'n/a'
          : String(Math.round(entry.correctnessRate * 100)) + '%',
        String(entry.correctnessBattles),
      ]),
      ['Category', 'Battles', 'W/L/T', 'Correctness', 'Sample'],
    );
  }

  ui.heading('Efficiency against its opponents');
  printEfficiency(ui, profile);

  ui.heading('Versions tested');
  if (profile.versions.length === 0) {
    ui.line('  No version has been battled yet.');
  } else {
    ui.table(
      profile.versions.map((version) => [
        version.commit ? version.commit.slice(0, 12) : 'unpinned',
        shortDate(version.createdAt),
        String(version.battles),
        recordText(version),
      ]),
      ['Commit', 'First seen', 'Battles', 'W/L/T'],
    );
  }

  ui.heading('Opponents');
  if (profile.opponents.length === 0) {
    ui.line('  Nobody yet.');
  } else {
    ui.table(
      profile.opponents.map((opponent) => [opponent.slug, opponent.name, recordText(opponent)]),
      ['Slug', 'Name', 'W/L/T'],
    );
  }

  ui.heading('Insights');
  if (profile.insights.length === 0) {
    ui.line('  Not enough battles for a claim that carries its sample.');
  } else {
    for (const insight of profile.insights) {
      ui.line('  ' + ui.sym.dot + ' ' + insight.text + ui.c.dim(' (n=' + String(insight.n) + ')'));
    }
  }

  const lineage = [...profile.lineage.ancestors, ...profile.lineage.descendants];
  ui.heading('Lineage');
  if (lineage.length === 0) {
    ui.line('  No declared ancestry. Arena never infers one.');
  } else {
    ui.table(
      profile.lineage.ancestors
        .map((edge) => ['parent', edge.relation, edge.parentSlug ?? edge.parentSource, edge.evidence])
        .concat(
          profile.lineage.descendants.map((edge) => [
            'child',
            edge.relation,
            edge.harnessSlug,
            edge.evidence,
          ]),
        ),
      ['Direction', 'Relation', 'Harness', 'Evidence'],
    );
  }

  ui.line();
  ui.line(ui.c.dim(COMMUNITY_NOTE));
}

// ---- arena h2h ----------------------------------------------------------------------------------

async function headToHeadCommand(
  deps: CliDeps,
  slug: string,
  other: string,
  flags: LeaderboardFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);

  const query = new URLSearchParams();
  if (flags.agent) query.set('agent', flags.agent);
  if (flags.category) query.set('category', parseCategory(flags.category));
  if (flags.pool) query.set('pool', parsePool(flags.pool));
  if (flags.benchmark) query.set('benchmark', flags.benchmark);
  if (flags.commit) query.set('commit', flags.commit);
  if (flags.since) query.set('since', flags.since);
  if (flags.until) query.set('until', flags.until);

  const json = await readOrThrow(
    deps,
    access,
    '/api/v1/harnesses/' +
      encodeURIComponent(slug) +
      '/vs/' +
      encodeURIComponent(other) +
      querySuffix(query),
    slug + ' against ' + other,
  );
  // The route may wrap the record or return it bare; both are accepted so a wrapper key cannot
  // break the command.
  const body = json as { headToHead?: unknown } | null;
  const parsed = headToHeadSchema.safeParse(body?.headToHead ?? json);
  if (!parsed.success) {
    throw new CliError(access.serverUrl + ' returned an unexpected head-to-head response.');
  }
  const h2h = parsed.data;

  if (ui.json) {
    ui.emitJson({ server: access.serverUrl, headToHead: h2h, note: COMMUNITY_NOTE });
    return;
  }

  ui.line(ui.c.bold(h2h.subject.name + ' vs ' + h2h.opponent.name));
  ui.detail('Slugs', h2h.subject.slug + ' vs ' + h2h.opponent.slug);
  ui.detail('Decided', String(h2h.battles));
  ui.detail('W/L/T', recordText(h2h));
  ui.detail('Win rate', rateText(h2h.wins, h2h.battles));
  ui.detail('Inconclusive', String(h2h.inconclusive));
  ui.detail('Last battle', h2h.lastBattleAt ? shortDate(h2h.lastBattleAt) : 'never');
  if (h2h.recentBattleIds.length > 0) ui.detail('Recent', h2h.recentBattleIds.join(', '));
  ui.line();
  ui.line(ui.c.dim(COMMUNITY_NOTE));
}

// ---- arena badge --------------------------------------------------------------------------------

/** URL building only: no request is made, so a badge snippet works offline. */
async function badgeCommand(deps: CliDeps, slug: string, flags: LeaderboardFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);
  const kind = flags.kind ? parseBadgeKind(flags.kind) : 'rating';

  const query = new URLSearchParams();
  if (flags.category) query.set('category', parseCategory(flags.category));
  if (flags.agent) query.set('agent', flags.agent);

  const url =
    access.serverUrl + '/api/v1/badges/' + encodeURIComponent(slug) + '/' + kind + querySuffix(query);
  const profileUrl = access.serverUrl + '/harnesses/' + encodeURIComponent(slug);
  const label = BADGE_KIND_LABELS[kind];
  const markdown = '[![' + label + '](' + url + ')](' + profileUrl + ')';

  if (ui.json) {
    ui.emitJson({ slug, kind, label, url, profileUrl, markdown });
    return;
  }
  if (flags.markdown === true) {
    ui.line(markdown);
    return;
  }
  ui.line(ui.c.bold(label) + ' badge for ' + slug);
  ui.detail('Image', url);
  ui.detail('Profile', profileUrl);
  ui.line();
  ui.line(markdown);
  ui.line();
  ui.line(
    ui.c.dim(
      'The badge reads the community pool and states its sample; ' +
        (kind === 'verified-rating'
          ? 'verified-rating says "no verified battles" while no hosted runner exists.'
          : 'a rating under the minimum sample renders as provisional.'),
    ),
  );
}

// ---- registration -------------------------------------------------------------------------------

const JSON_FLAG = 'print machine-readable JSON on stdout (human lines go to stderr)';

/** arena leaderboard, rating, profile, h2h, badge: read the server. No login needed. */
export function registerLeaderboardCommands(program: Command, deps: CliDeps): void {
  program
    .command('leaderboard')
    .description('ranked harnesses for a category and pool, read from the server')
    .option('--category <name>', 'rating category (default overall)')
    .option('--pool <pool>', 'community | verified (default community)')
    .option('--agent <id>', 'only ratings earned under this agent CLI')
    .option('--limit <n>', 'how many entries to show')
    .option('--server <url>', 'Arena server')
    .option('--json', JSON_FLAG)
    .action(async (_options: unknown, command: Command) => {
      await leaderboardCommand(deps, command.optsWithGlobals() as LeaderboardFlags);
    });

  program
    .command('rating')
    .description('one harness rating: current, peak, deviation, record and form')
    .argument('<slug>', 'harness slug as the server catalogues it')
    .option('--agent <id>', 'the agent CLI the rating was earned under')
    .option('--category <name>', 'rating category (default overall)')
    .option('--pool <pool>', 'community | verified (default community)')
    .option('--history', 'also print every rating event behind the number')
    .option('--server <url>', 'Arena server')
    .option('--json', JSON_FLAG)
    .action(async (slug: string, _options: unknown, command: Command) => {
      await ratingCommand(deps, slug, command.optsWithGlobals() as LeaderboardFlags);
    });

  program
    .command('profile')
    .description('everything the server knows about one harness')
    .argument('<slug>', 'harness slug as the server catalogues it')
    .option('--server <url>', 'Arena server')
    .option('--json', JSON_FLAG)
    .action(async (slug: string, _options: unknown, command: Command) => {
      await profileCommand(deps, slug, command.optsWithGlobals() as LeaderboardFlags);
    });

  program
    .command('h2h')
    .description('the record between two harnesses, with the filters that produced it')
    .argument('<slug>', 'the harness you are asking about')
    .argument('<other>', 'the opponent harness')
    .option('--agent <id>', 'only battles run under this agent CLI')
    .option('--category <name>', 'only battles in this category')
    .option('--pool <pool>', 'community | verified')
    .option('--benchmark <slug>', 'only battles from this benchmark pack')
    .option('--commit <sha>', 'only battles where the first harness ran this commit (prefix allowed)')
    .option('--since <date>', 'only battles created on or after this ISO date')
    .option('--until <date>', 'only battles created on or before this ISO date')
    .option('--server <url>', 'Arena server')
    .option('--json', JSON_FLAG)
    .action(async (slug: string, other: string, _options: unknown, command: Command) => {
      await headToHeadCommand(deps, slug, other, command.optsWithGlobals() as LeaderboardFlags);
    });

  program
    .command('badge')
    .description('the badge URL and Markdown snippet for a harness README')
    .argument('<slug>', 'harness slug as the server catalogues it')
    .option('--kind <kind>', 'rating | verified-rating | win-rate | correctness | battles | tokens | top')
    .option('--category <name>', 'category the badge reads (default overall)')
    .option('--agent <id>', 'agent CLI the badge reads')
    .option('--markdown', 'print only the Markdown snippet')
    .option('--server <url>', 'Arena server')
    .option('--json', JSON_FLAG)
    .action(async (slug: string, _options: unknown, command: Command) => {
      await badgeCommand(deps, slug, command.optsWithGlobals() as LeaderboardFlags);
    });
}
