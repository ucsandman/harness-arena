import { Command, Option } from 'commander';
import { resolveDeps } from './deps.js';
import type { CliDeps } from './deps.js';
import { battleCommand } from './commands/battle.js';
import type { BattleFlags } from './commands/battle.js';
import { runCommand } from './commands/run.js';
import type { RunFlags } from './commands/run.js';
import { demoCommand } from './commands/demo.js';
import type { DemoFlags } from './commands/demo.js';
import { openCommand, replayCommand } from './commands/replay.js';
import type { ReplayFlags } from './commands/replay.js';
import { statusCommand } from './commands/status.js';
import type { StatusFlags } from './commands/status.js';
import { listCommand } from './commands/list.js';
import type { ListFlags } from './commands/list.js';
import { agentsCommand } from './commands/agents.js';
import { harnessInspectCommand, harnessListCommand } from './commands/harnesses.js';
import type { InspectFlags } from './commands/harnesses.js';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login.js';
import type { LoginFlags } from './commands/login.js';
import { doctorCommand } from './commands/doctor.js';
import type { DoctorFlags } from './commands/doctor.js';
import { regressionCommand } from './commands/regression.js';
import type { RegressionFlags } from './commands/regression.js';
import { cleanCommand } from './commands/clean.js';
import type { CleanFlags } from './commands/clean.js';
import { welcomeCommand } from './commands/welcome.js';

/**
 * The command surface. `createProgram(deps)` builds it against injected dependencies so tests can
 * parse an argv and assert exactly what the engine was handed, with no process, network or agent CLI
 * involved. Commander never exits the process here: `exitOverride` turns exits into errors that
 * bin.ts translates into an exit code.
 */

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * `--home` is declared once, on the program. Commander gives a parent option precedence over a
 * same-named option on a subcommand, so declaring it in both places silently dropped
 * `arena demo --home X`; every handler therefore reads `command.optsWithGlobals()`.
 */
function withJson(command: Command): Command {
  return command.option('--json', 'print machine-readable JSON on stdout (human lines go to stderr)');
}

/** Flags as a handler sees them: the command's own options plus the global ones. */
function flagsOf<T>(command: Command): T {
  return command.optsWithGlobals() as T;
}

export function createProgram(partial: Partial<CliDeps> = {}): Command {
  const deps = resolveDeps(partial);
  const program = new Command();

  program
    .name('arena')
    .description(
      'Battle two AI coding-agent harnesses on the same task using the CLIs and subscriptions you already have.',
    )
    .version(deps.arenaVersion, '-v, --version')
    .option('--home <dir>', 'use this directory instead of ARENA_HOME / ~/.harness-arena')
    .exitOverride()
    .showHelpAfterError('(run `arena --help` for the full list)')
    .configureOutput({
      writeOut: (text) => deps.writeOut(text),
      writeErr: (text) => deps.writeErr(text),
    });

  // ---- arena battle ---------------------------------------------------------------------------
  const battle = program
    .command('battle', { isDefault: false })
    .description('run two harnesses against the same task')
    .argument('[harnessA]', 'harness for side A: "vanilla", a GitHub URL, or a local path')
    .argument('[harnessB]', 'harness for side B')
    .option('--agent <id>', 'agent CLI for both sides (claude-code, codex, gemini-cli, opencode, fake)')
    .option('--agent-a <id>', 'agent CLI for side A')
    .option('--agent-b <id>', 'agent CLI for side B')
    .option('--model <name>', 'model for both sides, passed to the CLI as-is')
    .option('--model-a <name>', 'model for side A')
    .option('--model-b <name>', 'model for side B')
    .option(
      '--repo <url|path>',
      'repository to work in (default: the current directory when it is a git repo)',
    )
    .option('--ref <ref>', 'branch, tag or commit to start from')
    .option('--task <text>', 'the task both sides receive verbatim')
    .option('--task-file <path>', 'read the task from a file')
    .option('--issue <ref>', 'use a GitHub issue as the task (owner/name#123, or 123 with a GitHub --repo)')
    .option('--tests <command>', 'test command used for the baseline and the evaluation')
    .option('--build <command>', 'build/check command (repeatable)', collect, [])
    .option('--timeout <duration>', 'per-side timeout, e.g. 20m, 900s, 1h30m')
    .option('--max-turns <n>', 'stop a side after this many agent turns')
    .option('--max-budget-usd <n>', 'stop a side when the CLI reports this much spend')
    .option('--parallel', 'run both sides at once (less fair on a shared CPU)')
    .option('--trust', 'approve harness install/prepare commands without asking')
    .option('--local-only', 'never upload: no battle data leaves this machine')
    .option('--upload <level>', 'none | metrics | events | full')
    .option('--exclude <list>', 'privacy exclusions, comma separated')
    .option('--visibility <level>', 'private | unlisted | public')
    .option('--title <text>', 'battle title')
    .option('--category <name>', 'category hint for ratings (debugging, refactoring, greenfield, …)')
    .option('--label-a <text>', 'display label for side A')
    .option('--label-b <text>', 'display label for side B')
    .option('--open', 'open the report when the battle finishes')
    .option('--keep-workspaces', 'keep the run workspaces for inspection')
    .option('--yes', 'accept the defaults and never prompt')
    .option('--server <url>', 'Arena server for uploads');
  withJson(battle).action(
    async (
      harnessA: string | undefined,
      harnessB: string | undefined,
      _options: unknown,
      command: Command,
    ) => {
      await battleCommand(deps, harnessA, harnessB, flagsOf<BattleFlags>(command));
    },
  );

  // ---- arena run ------------------------------------------------------------------------------
  const run = program
    .command('run')
    .description('run a battle spec from a file, or a pending battle from the server')
    .argument('[battle.json]', 'path to a battle spec')
    .option('--battle <id>', 'fetch a pending battle from the server and run it')
    .option('--server <url>', 'Arena server')
    .option('--trust', 'approve harness install/prepare commands without asking')
    .option('--local-only', 'never upload: no battle data leaves this machine')
    .option('--keep-workspaces', 'keep the run workspaces for inspection')
    .option('--open', 'open the report when the battle finishes');
  withJson(run).action(async (file: string | undefined, _options: unknown, command: Command) => {
    await runCommand(deps, file, flagsOf<RunFlags>(command));
  });

  // ---- arena demo -----------------------------------------------------------------------------
  const demo = program
    .command('demo')
    .description('run the deterministic demo battle (no agent CLI, no network, no model spend)')
    .option('--open', 'open the report when it finishes')
    .option('--export <dir>', 'write battle.json and events.ndjson to a directory');
  withJson(demo).action(async (_options: unknown, command: Command) => {
    await demoCommand(deps, flagsOf<DemoFlags>(command));
  });

  // ---- arena replay / open --------------------------------------------------------------------
  const replay = program
    .command('replay')
    .description('rebuild report.html from a stored battle and open it')
    .argument('[id]', 'battle id (default: the newest battle)')
    .addOption(new Option('--no-open', 'rebuild the report without opening it'));
  withJson(replay).action(async (id: string | undefined, _options: unknown, command: Command) => {
    await replayCommand(deps, id, flagsOf<ReplayFlags>(command));
  });

  const openCmd = program
    .command('open')
    .description('open the report of a stored battle')
    .argument('[id]', 'battle id (default: the newest battle)');
  withJson(openCmd).action(async (id: string | undefined, _options: unknown, command: Command) => {
    await openCommand(deps, id, flagsOf<{ home?: string; json?: boolean }>(command));
  });

  // ---- arena status / list --------------------------------------------------------------------
  const status = program
    .command('status')
    .description('status of a battle, with --watch to tail its events')
    .argument('[id]', 'battle id (default: the newest battle)')
    .option('--watch', 'print new events until the battle finishes');
  withJson(status).action(async (id: string | undefined, _options: unknown, command: Command) => {
    await statusCommand(deps, id, flagsOf<StatusFlags>(command));
  });

  const list = program
    .command('list')
    .description('battles stored under ARENA_HOME, newest first')
    .option('--limit <n>', 'how many to show (default 20)');
  withJson(list).action(async (_options: unknown, command: Command) => {
    await listCommand(deps, flagsOf<ListFlags>(command));
  });

  // ---- arena agents ---------------------------------------------------------------------------
  withJson(
    program.command('agents').description('which agent CLIs are installed and what they report'),
  ).action(async (_options: unknown, command: Command) => {
    await agentsCommand(deps, flagsOf<{ json?: boolean }>(command));
  });

  // ---- arena harnesses ------------------------------------------------------------------------
  const harnesses = program.command('harnesses').description('inspect and list harnesses');
  const inspect = harnesses
    .command('inspect')
    .description('compatibility report for a harness (nothing is executed)')
    .argument('<url|path>', 'GitHub URL or local directory')
    .option('--ref <ref>', 'branch, tag or commit')
    .option('--agent <id>', 'agent the harness would run under (default claude-code)');
  withJson(inspect).action(async (source: string, _options: unknown, command: Command) => {
    await harnessInspectCommand(deps, source, flagsOf<InspectFlags>(command));
  });
  withJson(harnesses.command('list').description('harnesses cached under ARENA_HOME')).action(
    async (_options: unknown, command: Command) => {
      await harnessListCommand(deps, flagsOf<{ json?: boolean; home?: string }>(command));
    },
  );

  // ---- account --------------------------------------------------------------------------------
  const login = program
    .command('login')
    .description('connect this machine to an Arena account (device flow)')
    .option('--server <url>', 'Arena server')
    .addOption(new Option('--no-browser', 'do not open a browser automatically'));
  withJson(login).action(async (_options: unknown, command: Command) => {
    await loginCommand(deps, flagsOf<LoginFlags>(command));
  });

  withJson(
    program
      .command('logout')
      .description('delete the local device token and revoke it server-side')
      .option('--server <url>', 'Arena server'),
  ).action(async (_options: unknown, command: Command) => {
    await logoutCommand(deps, flagsOf<LoginFlags>(command));
  });

  withJson(
    program
      .command('whoami')
      .description('who this machine is logged in as')
      .option('--server <url>', 'Arena server'),
  ).action(async (_options: unknown, command: Command) => {
    await whoamiCommand(deps, flagsOf<LoginFlags>(command));
  });

  // ---- arena doctor ---------------------------------------------------------------------------
  const doctor = program
    .command('doctor')
    .description('check the environment and clean up after crashes')
    .option('--fix', 'remove orphaned workspaces and stale locks (only inside ARENA_HOME)');
  withJson(doctor).action(async (_options: unknown, command: Command) => {
    await doctorCommand(deps, flagsOf<DoctorFlags>(command));
  });

  // ---- arena regression -----------------------------------------------------------------------
  const regression = program
    .command('regression')
    .description('run a directory of battle specs with a baseline and a candidate harness')
    .argument('<dir>', 'directory of *.json battle specs')
    .requiredOption('--baseline <harness>', 'harness used for side A')
    .requiredOption('--candidate <harness>', 'harness used for side B')
    .option('--agent <id>', 'agent CLI for both sides (default: whatever each spec names)')
    .option('--markdown <file>', 'also write the table as Markdown for a GitHub check')
    .option('--trust', 'approve harness install/prepare commands without asking');
  withJson(regression).action(async (dir: string, _options: unknown, command: Command) => {
    await regressionCommand(deps, dir, flagsOf<RegressionFlags>(command));
  });

  // ---- arena clean ----------------------------------------------------------------------------
  const clean = program
    .command('clean')
    .description('remove finished battle directories from ARENA_HOME')
    .option('--older-than <days>', 'only battles created more than this many days ago (default 30)')
    .option('--yes', 'do not ask for confirmation');
  withJson(clean).action(async (_options: unknown, command: Command) => {
    await cleanCommand(deps, flagsOf<CleanFlags>(command));
  });

  // ---- arena (no arguments) -------------------------------------------------------------------
  program.action(async () => {
    if (!deps.isTTY) {
      program.outputHelp();
      return;
    }
    await welcomeCommand(deps, flagsOf<{ home?: string }>(program));
  });

  return program;
}
