import type { Command } from 'commander';
import {
  ARENA_EXECUTION_NOTE,
  benchmarkPackSchema,
  challengeListResponseSchema,
  challengeResponseSchema,
  challengeStatusSchema,
  createChallengeRequestSchema,
} from '@harness-arena/protocol';
import type {
  AgentRef,
  BattleArenaLinks,
  BattleSpec,
  Challenge,
  CompetitorRef,
  CompetitorSpec,
  CreateChallengeRequest,
  PrivacySettings,
  Visibility,
  WorkTarget,
} from '@harness-arena/protocol';
import { expandBenchmark } from '@harness-arena/core';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import type { Ui } from '../ui.js';
import { getToken, resolveHome, resolveServerUrl } from '../config.js';
import { parseSpec, parseUploadLevel, parseVisibility, readTaskFile } from '../spec.js';
import { executeBattle, verdictLine } from '../runner.js';
import { CliError } from '../errors.js';
import { getJson, serverError } from './login.js';

/**
 * `arena challenge` — create a challenge on the server, and run one on this machine.
 *
 * Arena hosts no runner. A challenge is a DEFINITION: two harnesses, one agent, one task. Whoever
 * accepts it executes it here, with the agent CLI and the subscription they already have, and uploads
 * the battle afterwards. The server verifies that the uploaded battle really ran the two harnesses the
 * challenge names before linking it, and every linked result is labelled community.
 *
 * This file also holds the small server-access and spec-building helpers `arena tournament` imports,
 * so the two commands cannot drift apart on how a target becomes a battle.
 */

export interface ChallengeFlags {
  a?: string;
  b?: string;
  agent?: string;
  benchmark?: string;
  task?: string;
  repo?: string;
  title?: string;
  visibility?: string;
  upload?: string;
  /** commander sets this to false for --no-rating */
  rating?: boolean;
  status?: string;
  harness?: string;
  limit?: string;
  trust?: boolean;
  json?: boolean;
  home?: string;
  server?: string;
}

// ---- server access ------------------------------------------------------------------------------

export interface ServerAccess {
  serverUrl: string;
  /** null when this machine is not logged in; reads work without one, writes do not */
  token: string | null;
  home: string;
}

export async function serverAccess(
  deps: CliDeps,
  flags: { home?: string; server?: string },
): Promise<ServerAccess> {
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);
  const config = await store.getConfig();
  return { serverUrl: resolveServerUrl(deps, config, flags.server), token: await getToken(store), home };
}

/** A device token or a clear instruction. Never prints the token. */
export function requireToken(access: ServerAccess, what: string): string {
  if (!access.token) {
    throw new CliError(what + ' needs a login: run `arena login` first (battles work offline without it).');
  }
  return access.token;
}

export async function postJson(
  deps: CliDeps,
  url: string,
  body: unknown,
  token: string,
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'harness-arena/' + deps.arenaVersion,
        authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError('could not reach ' + url + ': ' + (err as Error).message);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** An unauthenticated GET, with the device token attached when this machine has one. */
export async function readJson(
  deps: CliDeps,
  access: ServerAccess,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const url = access.serverUrl + path;
  if (access.token) return getJson(deps, url, access.token);
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'harness-arena/' + deps.arenaVersion },
    });
  } catch (err) {
    throw new CliError('could not reach ' + url + ': ' + (err as Error).message);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

// ---- turning a work target into battle specs ------------------------------------------------------

export interface SpecBuildInput {
  title: string;
  agent: AgentRef;
  a: CompetitorRef;
  b: CompetitorRef;
  target: WorkTarget;
  privacy: PrivacySettings;
  visibility: Visibility;
  arena: BattleArenaLinks;
  trust: boolean;
}

function competitor(ref: CompetitorRef, agent: AgentRef, trust: boolean, fallback: string): CompetitorSpec {
  return {
    label: ref.label ?? fallback,
    agent,
    harness: { ...ref.harness, trusted: trust ? true : ref.harness.trusted },
  };
}

/**
 * One spec for an inline task, one per task-and-trial for a benchmark pack. `spec.arena` carries the id
 * of the object this work is for; the server re-verifies it against the battle's own runs before it
 * links anything, so setting it wrong loses the link rather than stealing one.
 */
export async function buildSpecs(
  deps: CliDeps,
  access: ServerAccess,
  input: SpecBuildInput,
): Promise<BattleSpec[]> {
  const a = competitor(input.a, input.agent, input.trust, 'side A');
  const b = competitor(input.b, input.agent, input.trust, 'side B');

  if (input.target.kind === 'task') {
    const target = input.target;
    return [
      parseSpec(
        {
          version: 1,
          title: target.title ?? input.title,
          task: target.task,
          repository: target.repository,
          competitors: { a, b },
          limits: target.limits,
          evaluation: target.evaluation,
          privacy: input.privacy,
          visibility: input.visibility,
          category: target.category,
          arena: input.arena,
        },
        'the challenge spec',
      ),
    ];
  }

  const target = input.target;
  const url =
    '/api/v1/benchmarks/' +
    encodeURIComponent(target.slug) +
    '?version=' +
    encodeURIComponent(target.versionId);
  const result = await readJson(deps, access, url);
  if (result.status === 404) {
    throw new CliError(
      'the server does not serve the benchmark pack ' +
        target.slug +
        '@' +
        target.versionId +
        ' (' +
        access.serverUrl +
        url +
        '). Publish the pack with `arena benchmark publish` first, or use a task target.',
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not read the benchmark pack ' + target.slug);
  }
  const body = result.json as { pack?: unknown; version?: { pack?: unknown } } | null;
  const candidate = body?.pack ?? body?.version?.pack ?? body;
  const parsed = benchmarkPackSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CliError(
      access.serverUrl +
        url +
        ' did not return a benchmark pack this CLI understands: ' +
        (parsed.error.issues[0]?.message ?? 'unknown shape'),
    );
  }
  const expanded = expandBenchmark(parsed.data, target.versionId, {
    a,
    b,
    agent: input.agent,
    privacy: input.privacy,
    visibility: input.visibility,
    arena: input.arena,
    ...(target.taskId ? { taskId: target.taskId } : {}),
  });
  return expanded.map((spec, index) => parseSpec(spec, 'benchmark task ' + String(index + 1)));
}

/** `--upload <level>` overrides the object's own privacy level; anything else is left alone. */
export function applyUpload(privacy: PrivacySettings, upload: string | undefined): PrivacySettings {
  if (upload === undefined) return privacy;
  return { ...privacy, upload: parseUploadLevel(upload) };
}

export function warnIfLocalOnly(ui: Ui, privacy: PrivacySettings, what: string): void {
  if (privacy.upload !== 'none') return;
  ui.warn(
    'this ' +
      what +
      ' uploads nothing (privacy.upload is none), so the result stays on this machine and the ' +
      what +
      ' will not complete. Pass --upload metrics (or events, or full) to publish it.',
  );
}

// ---- create -------------------------------------------------------------------------------------

function parseBenchmarkFlag(value: string): { slug: string; versionId: string } {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) {
    throw new CliError(
      '--benchmark must be <slug>@<versionId>, for example acme-pack@bmv_0123456789abcdef01234567 (got: ' +
        value +
        ')',
    );
  }
  return { slug: value.slice(0, at), versionId: value.slice(at + 1) };
}

function targetFromFlags(deps: CliDeps, flags: ChallengeFlags): unknown {
  if (flags.benchmark) {
    const parsed = parseBenchmarkFlag(flags.benchmark);
    return { kind: 'benchmark', slug: parsed.slug, versionId: parsed.versionId };
  }
  if (!flags.task || !flags.repo) {
    throw new CliError(
      'give the work: --benchmark <slug>@<versionId>, or --task <file> together with --repo <url|path>.',
    );
  }
  return {
    kind: 'task',
    task: { kind: 'prompt', prompt: readTaskFile(flags.task, deps.cwd()) },
    repository: { source: flags.repo },
  };
}

function parseChallenge(json: unknown, serverUrl: string): { challenge: Challenge; url: string } {
  const parsed = challengeResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      serverUrl + ' returned an unexpected challenge response; is it a Harness Arena server?',
    );
  }
  return { challenge: parsed.data.challenge, url: parsed.data.url };
}

function sideLabel(ref: CompetitorRef): string {
  return ref.label ?? ref.harness.source;
}

async function createChallengeCommand(deps: CliDeps, flags: ChallengeFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);
  const token = requireToken(access, 'creating a challenge');
  if (!flags.a || !flags.b) throw new CliError('--a <harness> and --b <harness> are both required.');
  if (!flags.agent) throw new CliError('--agent <id> is required: both sides run the same agent CLI.');

  // parsed, not hand-built: the schema fills every default the server would otherwise have to guess
  const parsedRequest = createChallengeRequestSchema.safeParse({
    title: flags.title ?? flags.a + ' vs ' + flags.b,
    sides: { a: { harness: { source: flags.a } }, b: { harness: { source: flags.b } } },
    agent: { id: flags.agent },
    target: targetFromFlags(deps, flags),
    privacy: { upload: flags.upload ? parseUploadLevel(flags.upload) : 'metrics' },
    visibility: flags.visibility ? parseVisibility(flags.visibility) : 'public',
    ratingEligible: flags.rating !== false,
  });
  if (!parsedRequest.success) {
    throw new CliError(
      'that challenge is not valid: ' +
        parsedRequest.error.issues
          .map((issue) => (issue.path.join('.') || '(root)') + ': ' + issue.message)
          .join('; '),
    );
  }
  const request: CreateChallengeRequest = parsedRequest.data;

  const result = await postJson(deps, access.serverUrl + '/api/v1/challenges', request, token);
  if (result.status === 401 || result.status === 403) {
    throw new CliError('the server rejected the device token. Run `arena login` again.');
  }
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not create the challenge');
  }
  const { challenge, url } = parseChallenge(result.json, access.serverUrl);

  if (ui.json) {
    ui.emitJson({ id: challenge.id, url, status: challenge.status, note: ARENA_EXECUTION_NOTE });
    return;
  }
  ui.success('created challenge ' + challenge.id);
  ui.detail('Title', challenge.title);
  ui.detail('Sides', sideLabel(challenge.sides.a) + ' vs ' + sideLabel(challenge.sides.b));
  ui.detail('Agent', challenge.agent.id);
  ui.detail('Web', url);
  ui.line();
  ui.line(ui.c.dim('Nobody has run anything yet. Whoever takes it on runs it on their own machine:'));
  ui.line('  arena challenge run ' + challenge.id);
}

// ---- list / show --------------------------------------------------------------------------------

async function listChallengesCommand(deps: CliDeps, flags: ChallengeFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);

  const query = new URLSearchParams();
  if (flags.status) {
    const status = challengeStatusSchema.safeParse(flags.status.trim().toLowerCase());
    if (!status.success) {
      throw new CliError('--status must be one of: ' + challengeStatusSchema.options.join(', '));
    }
    query.set('status', status.data);
  }
  if (flags.harness) query.set('harness', flags.harness);
  if (flags.limit) query.set('limit', flags.limit);
  const suffix = query.toString();
  const result = await readJson(deps, access, '/api/v1/challenges' + (suffix ? '?' + suffix : ''));
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not list challenges on ' + access.serverUrl);
  }
  const parsed = challengeListResponseSchema.safeParse(result.json);
  if (!parsed.success) {
    throw new CliError(access.serverUrl + ' returned an unexpected challenge list response');
  }
  const challenges = parsed.data.challenges;

  if (ui.json) {
    ui.emitJson({ challenges, count: parsed.data.count, note: ARENA_EXECUTION_NOTE });
    return;
  }
  if (challenges.length === 0) {
    ui.line('No open challenges on ' + access.serverUrl + '.');
    return;
  }
  ui.table(
    challenges.map((challenge) => [
      challenge.id,
      challenge.title,
      challenge.status,
      sideLabel(challenge.sides.a) + ' vs ' + sideLabel(challenge.sides.b),
      String(challenge.battleIds.length),
    ]),
    ['Id', 'Title', 'Status', 'Sides', 'Battles'],
  );
  ui.line();
  ui.line(ui.c.dim(ARENA_EXECUTION_NOTE));
}

async function fetchChallenge(
  deps: CliDeps,
  access: ServerAccess,
  id: string,
): Promise<{ challenge: Challenge; url: string }> {
  const result = await readJson(deps, access, '/api/v1/challenges/' + encodeURIComponent(id));
  if (result.status === 404) {
    throw new CliError('no challenge ' + id + ' is visible to you on ' + access.serverUrl);
  }
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not read challenge ' + id);
  }
  return parseChallenge(result.json, access.serverUrl);
}

async function showChallengeCommand(deps: CliDeps, id: string, flags: ChallengeFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);
  const { challenge, url } = await fetchChallenge(deps, access, id);

  if (ui.json) {
    ui.emitJson({ challenge, url, note: ARENA_EXECUTION_NOTE });
    return;
  }
  ui.line(ui.c.bold(challenge.title));
  ui.detail('Id', challenge.id);
  ui.detail('Status', challenge.status);
  ui.detail('Side A', sideLabel(challenge.sides.a));
  ui.detail('Side B', sideLabel(challenge.sides.b));
  ui.detail('Agent', challenge.agent.id);
  ui.detail(
    'Target',
    challenge.target.kind === 'benchmark'
      ? 'benchmark ' + challenge.target.slug + '@' + challenge.target.versionId
      : 'task in ' + challenge.target.repository.source,
  );
  ui.detail('Rated', challenge.ratingEligible ? 'yes, if the battle passes the integrity checks' : 'no');
  ui.detail('Battles', challenge.battleIds.length === 0 ? 'none yet' : challenge.battleIds.join(', '));
  ui.detail('Web', url);
  ui.line();
  ui.line(ui.c.dim(ARENA_EXECUTION_NOTE));
}

// ---- run ----------------------------------------------------------------------------------------

async function runChallengeCommand(deps: CliDeps, id: string, flags: ChallengeFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const access = await serverAccess(deps, flags);
  const token = requireToken(access, 'running a challenge');

  const fetched = await fetchChallenge(deps, access, id);
  if (fetched.challenge.status === 'cancelled' || fetched.challenge.status === 'expired') {
    throw new CliError('challenge ' + id + ' is ' + fetched.challenge.status + '; there is nothing to run.');
  }

  const accepted = await postJson(
    deps,
    access.serverUrl + '/api/v1/challenges/' + encodeURIComponent(id) + '/accept',
    {},
    token,
  );
  if (accepted.status < 200 || accepted.status >= 300) {
    throw serverError(accepted.status, accepted.json, 'could not accept challenge ' + id);
  }
  const { challenge, url } = parseChallenge(accepted.json, access.serverUrl);

  const privacy = applyUpload(challenge.privacy, flags.upload);
  warnIfLocalOnly(ui, privacy, 'challenge');

  const specs = await buildSpecs(deps, access, {
    title: challenge.title,
    agent: challenge.agent,
    a: challenge.sides.a,
    b: challenge.sides.b,
    target: challenge.target,
    privacy,
    visibility: challenge.visibility,
    arena: { challengeId: challenge.id },
    trust: flags.trust === true,
  });

  if (!ui.json) {
    ui.line(
      'Running challenge ' +
        challenge.id +
        ' on this machine: ' +
        String(specs.length) +
        (specs.length === 1 ? ' battle' : ' battles') +
        '.',
    );
  }

  const battles: Array<{ id: string; status: string; winner: string | null; url: string | null }> = [];
  for (const [index, spec] of specs.entries()) {
    if (!ui.json && specs.length > 1) {
      ui.status('battle ' + String(index + 1) + '/' + String(specs.length));
    }
    const outcome = await executeBattle(deps, ui, {
      spec,
      home: access.home,
      trust: flags.trust === true,
      localOnly: false,
      open: false,
      quiet: specs.length > 1,
      ...(flags.server ? { serverUrl: flags.server } : {}),
    });
    battles.push({
      id: outcome.record.id,
      status: outcome.record.status,
      winner: outcome.record.verdict?.winner ?? null,
      url: outcome.url,
    });
    if (!ui.json && specs.length === 1) {
      ui.line();
      ui.line(verdictLine(outcome.record, ui));
    }
    if (deps.signal?.aborted) break;
  }

  if (ui.json) {
    ui.emitJson({ challengeId: challenge.id, url, battles, note: ARENA_EXECUTION_NOTE });
    return;
  }
  ui.line();
  ui.detail('Challenge', url);
  ui.line(ui.c.dim('Your result is a community result: it was produced on your machine, not by Arena.'));
}

// ---- registration -------------------------------------------------------------------------------

/** arena challenge: create, list, show, run (accept and execute locally). */
export function registerChallengeCommands(program: Command, deps: CliDeps): void {
  const challenge = program
    .command('challenge')
    .description('create a harness-vs-harness challenge, or run one on this machine');

  challenge
    .command('create')
    .description('publish a challenge; nobody runs anything until someone accepts it')
    .requiredOption('--a <harness>', 'harness for side A: "vanilla", a GitHub URL, or a local path')
    .requiredOption('--b <harness>', 'harness for side B')
    .requiredOption('--agent <id>', 'agent CLI both sides run (claude-code, codex, gemini-cli, opencode)')
    .option('--benchmark <slug@versionId>', 'run a published benchmark pack version')
    .option('--task <file>', 'read the task both sides receive from a file')
    .option('--repo <url|path>', 'repository the task is performed in (with --task)')
    .option('--title <text>', 'challenge title')
    .option('--visibility <level>', 'private | unlisted | public (default public)')
    .option('--upload <level>', 'privacy level the accepter uploads at: none | metrics | events | full')
    .option('--no-rating', 'the result must not move community ratings')
    .option('--server <url>', 'Arena server')
    .option('--json', 'print machine-readable JSON on stdout (human lines go to stderr)')
    .action(async (_options: unknown, command: Command) => {
      await createChallengeCommand(deps, command.optsWithGlobals() as ChallengeFlags);
    });

  challenge
    .command('list')
    .description('open challenges on the server')
    .option('--status <status>', 'open | accepted | completed | cancelled | expired')
    .option('--harness <slug>', 'only challenges involving this harness slug')
    .option('--limit <n>', 'how many to show')
    .option('--server <url>', 'Arena server')
    .option('--json', 'print machine-readable JSON on stdout (human lines go to stderr)')
    .action(async (_options: unknown, command: Command) => {
      await listChallengesCommand(deps, command.optsWithGlobals() as ChallengeFlags);
    });

  challenge
    .command('show')
    .description('one challenge: its definition, its status and the battles linked to it')
    .argument('<id>', 'challenge id (chl_…)')
    .option('--server <url>', 'Arena server')
    .option('--json', 'print machine-readable JSON on stdout (human lines go to stderr)')
    .action(async (id: string, _options: unknown, command: Command) => {
      await showChallengeCommand(deps, id, command.optsWithGlobals() as ChallengeFlags);
    });

  challenge
    .command('run')
    .description('accept a challenge and run it HERE, on your machine, then upload the battle')
    .argument('<id>', 'challenge id (chl_…)')
    .option('--trust', 'approve harness install/prepare commands without asking')
    .option('--upload <level>', 'override the challenge privacy level: none | metrics | events | full')
    .option('--server <url>', 'Arena server')
    .option('--json', 'print machine-readable JSON on stdout (human lines go to stderr)')
    .action(async (id: string, _options: unknown, command: Command) => {
      await runChallengeCommand(deps, id, command.optsWithGlobals() as ChallengeFlags);
    });
}
