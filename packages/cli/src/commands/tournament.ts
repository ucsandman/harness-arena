import type { Command } from 'commander';
import { ARENA_EXECUTION_NOTE, tournamentResponseSchema } from '@harness-arena/protocol';
import type { CompetitorRef, Tournament, TournamentEntrant, TournamentMatch } from '@harness-arena/protocol';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import { executeBattle } from '../runner.js';
import { CliError } from '../errors.js';
import { serverError } from './login.js';
import {
  applyUpload,
  buildSpecs,
  readJson,
  requireToken,
  serverAccess,
  warnIfLocalOnly,
  type ServerAccess,
} from './challenge.js';

/**
 * `arena tournament` — read a bracket, and play its pending matches on this machine.
 *
 * Arena hosts no runner. A tournament is a bracket of DEFINITIONS; each match is executed here, by
 * whoever runs this command, and uploaded. The server verifies that the battle ran the two entrants the
 * slot names (side A must be entrant A) before it settles the match and advances the winner. Any number
 * of people can play the same tournament at once: a match settles once, on the first verified battle.
 */

export interface TournamentFlags {
  trust?: boolean;
  upload?: string;
  json?: boolean;
  home?: string;
  server?: string;
}

/** A server that never settles a match must not spin this loop forever. */
export const MAX_TOURNAMENT_PASSES = 32;

async function fetchTournament(
  deps: CliDeps,
  access: ServerAccess,
  idOrSlug: string,
): Promise<{ tournament: Tournament; url: string }> {
  const result = await readJson(deps, access, '/api/v1/tournaments/' + encodeURIComponent(idOrSlug));
  if (result.status === 404) {
    throw new CliError('no tournament ' + idOrSlug + ' on ' + access.serverUrl);
  }
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not read tournament ' + idOrSlug);
  }
  const parsed = tournamentResponseSchema.safeParse(result.json);
  if (!parsed.success) {
    throw new CliError(
      access.serverUrl + ' returned an unexpected tournament response; is it a Harness Arena server?',
    );
  }
  return { tournament: parsed.data.tournament, url: parsed.data.url };
}

/** Entrants are addressed by their `index` field, which is not their position in the array. */
function entrantAt(tournament: Tournament, index: number | null): TournamentEntrant | null {
  if (index === null) return null;
  return tournament.entrants.find((entrant) => entrant.index === index) ?? null;
}

function entrantName(tournament: Tournament, index: number | null): string {
  const entrant = entrantAt(tournament, index);
  if (!entrant) return '—';
  return entrant.seed === null ? entrant.label : '(' + String(entrant.seed) + ') ' + entrant.label;
}

/** Both slots filled, nobody has won: exactly the matches this machine can play. */
export function pendingOf(tournament: Tournament): TournamentMatch[] {
  const pending: TournamentMatch[] = [];
  for (const round of tournament.rounds) {
    for (const match of round.matches) {
      if (match.a !== null && match.b !== null && match.winner === null) pending.push(match);
    }
  }
  return pending;
}

function competitorFor(entrant: TournamentEntrant): CompetitorRef {
  return { label: entrant.label, harness: entrant.harness };
}

// ---- show ---------------------------------------------------------------------------------------

async function showTournamentCommand(deps: CliDeps, idOrSlug: string, flags: TournamentFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);
  const { tournament, url } = await fetchTournament(deps, access, idOrSlug);

  if (ui.json) {
    ui.emitJson({ tournament, url, pending: pendingOf(tournament).length, note: ARENA_EXECUTION_NOTE });
    return;
  }

  ui.line(ui.c.bold(tournament.name));
  ui.detail('Id', tournament.id);
  ui.detail('Slug', tournament.slug);
  ui.detail('Status', tournament.status);
  ui.detail('Agent', tournament.agent.id);
  ui.detail('Winner', tournament.winner === null ? 'undecided' : entrantName(tournament, tournament.winner));

  ui.heading('Entrants');
  ui.table(
    [...tournament.entrants]
      .sort((a, b) => (a.seed ?? Infinity) - (b.seed ?? Infinity))
      .map((entrant) => [
        entrant.seed === null ? '—' : String(entrant.seed),
        entrant.label,
        entrant.harnessSlug ?? 'not catalogued yet',
      ]),
    ['Seed', 'Entrant', 'Harness'],
  );

  for (const round of tournament.rounds) {
    ui.heading('Round ' + String(round.index + 1));
    ui.table(
      round.matches.map((match) => [
        entrantName(tournament, match.a),
        match.bye ? 'bye' : entrantName(tournament, match.b),
        match.winner === null ? 'pending' : entrantName(tournament, match.winner),
        match.settledBy ?? '',
        String(match.battleIds.length),
      ]),
      ['Side A', 'Side B', 'Winner', 'Settled by', 'Battles'],
    );
  }

  const pending = pendingOf(tournament);
  ui.line();
  ui.line(
    pending.length === 0
      ? ui.c.dim('No match is waiting to be played.')
      : String(pending.length) +
          ' match(es) waiting. Play them on this machine: arena tournament play ' +
          tournament.id,
  );
  ui.line(ui.c.dim(ARENA_EXECUTION_NOTE));
}

// ---- play ---------------------------------------------------------------------------------------

async function playTournamentCommand(deps: CliDeps, idOrSlug: string, flags: TournamentFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);
  requireToken(access, 'playing a tournament match');

  const played: Array<{
    matchId: string;
    battleId: string;
    status: string;
    winner: string | null;
    url: string | null;
  }> = [];
  let url = '';
  let remaining = 0;
  let stopped: string | null = null;

  for (let pass = 0; pass < MAX_TOURNAMENT_PASSES; pass++) {
    const fetched = await fetchTournament(deps, access, idOrSlug);
    url = fetched.url;
    const tournament = fetched.tournament;
    if (tournament.status === 'cancelled') {
      stopped = 'the tournament was cancelled';
      remaining = 0;
      break;
    }
    const pending = pendingOf(tournament);
    remaining = pending.length;
    if (pending.length === 0) break;

    const privacy = applyUpload(
      // a tournament has no privacy of its own: a match must be uploaded or it can never settle
      { upload: 'metrics', exclude: [], redact: true },
      flags.upload,
    );
    if (pass === 0) warnIfLocalOnly(ui, privacy, 'tournament');

    let ranOne = false;
    for (const match of pending) {
      const a = entrantAt(tournament, match.a);
      const b = entrantAt(tournament, match.b);
      if (!a || !b) continue;

      const specs = await buildSpecs(deps, access, {
        title: tournament.name + ': ' + a.label + ' vs ' + b.label,
        agent: tournament.agent,
        a: competitorFor(a),
        b: competitorFor(b),
        target: tournament.target,
        privacy,
        visibility: tournament.visibility,
        arena: { tournamentMatchId: match.id },
        trust: flags.trust === true,
      });

      for (const spec of specs) {
        if (!ui.json) ui.status('round ' + String(match.round + 1) + ': ' + a.label + ' vs ' + b.label);
        const outcome = await executeBattle(deps, ui, {
          spec,
          home: access.home,
          trust: flags.trust === true,
          localOnly: false,
          open: false,
          quiet: true,
          ...(flags.server ? { serverUrl: flags.server } : {}),
        });
        ranOne = true;
        played.push({
          matchId: match.id,
          battleId: outcome.record.id,
          status: outcome.record.status,
          winner: outcome.record.verdict?.winner ?? null,
          url: outcome.url,
        });
        if (outcome.record.status !== 'completed') {
          stopped = 'battle ' + outcome.record.id + ' ended ' + outcome.record.status;
          break;
        }
      }
      if (stopped || deps.signal?.aborted) break;
    }

    if (stopped) break;
    if (deps.signal?.aborted) {
      stopped = 'cancelled';
      break;
    }
    // the server settles matches from the uploads; if nothing ran, another pass would loop forever
    if (!ranOne) {
      stopped = 'no match could be started';
      break;
    }
  }

  if (ui.json) {
    ui.emitJson({ tournament: idOrSlug, url, played, remaining, stopped, note: ARENA_EXECUTION_NOTE });
    return;
  }
  ui.line();
  if (played.length === 0) {
    ui.line(stopped ? 'Nothing was played: ' + stopped + '.' : 'No match is waiting to be played.');
  } else {
    ui.success('played ' + String(played.length) + ' match(es) on this machine');
    ui.table(
      played.map((entry) => [entry.matchId, entry.battleId, entry.status, entry.winner ?? 'n/a']),
      ['Match', 'Battle', 'Status', 'Winner'],
    );
    if (stopped) ui.warn('stopped early: ' + stopped);
  }
  if (url) ui.detail('Bracket', url);
  ui.line(ui.c.dim(ARENA_EXECUTION_NOTE));
}

// ---- registration -------------------------------------------------------------------------------

/** arena tournament: show a bracket, play its pending matches locally. */
export function registerTournamentCommands(program: Command, deps: CliDeps): void {
  const tournament = program
    .command('tournament')
    .description('read a tournament bracket, or play its pending matches on this machine');

  tournament
    .command('show')
    .description('the bracket: entrants, seeds, matches and how each one settled')
    .argument('<id-or-slug>', 'tournament id (trn_…) or slug')
    .option('--server <url>', 'Arena server')
    .option('--json', 'print machine-readable JSON on stdout (human lines go to stderr)')
    .action(async (idOrSlug: string, _options: unknown, command: Command) => {
      await showTournamentCommand(deps, idOrSlug, command.optsWithGlobals() as TournamentFlags);
    });

  tournament
    .command('play')
    .description('run every pending match HERE, on your machine, uploading each one so it settles')
    .argument('<id-or-slug>', 'tournament id (trn_…) or slug')
    .option('--trust', 'approve harness install/prepare commands without asking')
    .option('--upload <level>', 'privacy level for the uploads: none | metrics | events | full')
    .option('--server <url>', 'Arena server')
    .option('--json', 'print machine-readable JSON on stdout (human lines go to stderr)')
    .action(async (idOrSlug: string, _options: unknown, command: Command) => {
      await playTournamentCommand(deps, idOrSlug, command.optsWithGlobals() as TournamentFlags);
    });
}
