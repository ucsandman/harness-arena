import path from 'node:path';
import { isGitRepo } from '@harness-arena/core';
import { describeExecution } from '@harness-arena/harness';
import type { BattleSpec, BattleSpecInput, PrivacyExclusion, Side } from '@harness-arena/protocol';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import type { Ui } from '../ui.js';
import { recentHarnesses, rememberHarnesses, resolveHome } from '../config.js';
import {
  parseDuration,
  parseExclusions,
  parseIssueRef,
  parsePositiveInt,
  parsePositiveNumber,
  parseSpec,
  parseUploadLevel,
  parseVisibility,
  readTaskFile,
} from '../spec.js';
import type { UploadLevel } from '../spec.js';
import { executeBattle, finishBattle, sideLabel } from '../runner.js';
import { resolveHarnessForCli } from '../harness.js';
import { CancelledError, CliError } from '../errors.js';
import { collectAgentRows } from './agents.js';
import type { AgentRow } from './agents.js';

export interface BattleFlags {
  agent?: string;
  agentA?: string;
  agentB?: string;
  model?: string;
  modelA?: string;
  modelB?: string;
  repo?: string;
  ref?: string;
  task?: string;
  taskFile?: string;
  issue?: string;
  tests?: string;
  build?: string[];
  timeout?: string;
  maxTurns?: string;
  maxBudgetUsd?: string;
  parallel?: boolean;
  trust?: boolean;
  localOnly?: boolean;
  upload?: string;
  exclude?: string;
  visibility?: string;
  title?: string;
  category?: string;
  labelA?: string;
  labelB?: string;
  json?: boolean;
  open?: boolean;
  keepWorkspaces?: boolean;
  yes?: boolean;
  home?: string;
  server?: string;
}

const VANILLA = 'vanilla';

function requireValue<T>(value: T | null, what: string): T {
  if (value === null) throw new CancelledError('Cancelled before ' + what + '.');
  return value;
}

async function pickHarness(deps: CliDeps, side: Side, recents: readonly string[]): Promise<string> {
  const choice = await deps.prompter.select<string>({
    message: 'Harness ' + side.toUpperCase() + ': what should this side run?',
    options: [
      { value: VANILLA, label: 'vanilla', hint: 'the agent CLI with its own defaults, no harness files' },
      { value: '@url', label: 'a GitHub repository', hint: 'https://github.com/owner/harness' },
      { value: '@path', label: 'a local directory', hint: 'a folder with CLAUDE.md, .claude/, AGENTS.md …' },
      ...recents.map((source) => ({ value: source, label: source, hint: 'recently used' })),
    ],
  });
  const selected = requireValue(choice, 'the harness was chosen');
  if (selected !== '@url' && selected !== '@path') return selected;
  const prompt = await deps.prompter.text({
    message: selected === '@url' ? 'GitHub URL of the harness' : 'Path to the harness directory',
    placeholder: selected === '@url' ? 'https://github.com/owner/harness' : '.',
    validate: (value) => (value.trim().length === 0 ? 'required' : undefined),
  });
  return requireValue(prompt, 'the harness was chosen').trim();
}

function agentChoiceLabel(row: AgentRow): string {
  const state = row.installed ? (row.version ?? 'installed') : 'not installed';
  const auth = row.installed && row.auth === 'missing' ? ', not signed in' : '';
  return row.displayName + ' (' + state + auth + ')';
}

async function pickAgent(deps: CliDeps, rows: readonly AgentRow[]): Promise<string> {
  const installed = rows.filter((row) => row.installed);
  if (installed.length === 0) {
    throw new CliError(
      'no agent CLI was found on PATH. Install Claude Code, Codex, Gemini CLI or OpenCode and sign in, then run `arena agents`.',
    );
  }
  const choice = await deps.prompter.select<string>({
    message: 'Which agent CLI should both sides use?',
    options: installed.map((row) => ({ value: row.id, label: agentChoiceLabel(row) })),
    initialValue: installed[0]?.id,
  });
  return requireValue(choice, 'the agent was chosen');
}

/** Refuses an agent that is not installed: a battle that cannot run should fail before it starts. */
export function requireInstalledAgent(rows: readonly AgentRow[], id: string): AgentRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) {
    throw new CliError(
      'unknown agent "' + id + '". Known agents: ' + rows.map((candidate) => candidate.id).join(', '),
    );
  }
  if (!row.installed) {
    throw new CliError(
      row.displayName +
        ' was not found on PATH (looked for "' +
        row.id +
        '"). Install it and sign in with your own subscription, then check `arena agents`.',
    );
  }
  return row;
}

async function resolveRepository(deps: CliDeps, flags: BattleFlags, interactive: boolean): Promise<string> {
  if (flags.repo && flags.repo.trim().length > 0) return flags.repo.trim();
  const cwd = deps.cwd();
  const cwdIsRepo = await isGitRepo(cwd);
  if (!interactive) {
    if (cwdIsRepo) return cwd;
    throw new CliError(
      '--repo is required: the working directory is not a git repository. Pass a GitHub URL, a local path, or "empty" for a greenfield task.',
    );
  }
  const answer = await deps.prompter.text({
    message: 'Repository to work in',
    placeholder: cwdIsRepo ? cwd : 'https://github.com/owner/project or empty',
    ...(cwdIsRepo ? { defaultValue: cwd, initialValue: cwd } : {}),
    validate: (value) => (value.trim().length === 0 ? 'required' : undefined),
  });
  return requireValue(answer, 'the repository was chosen').trim();
}

type TaskSpec = BattleSpecInput['task'];

async function resolveTask(
  deps: CliDeps,
  flags: BattleFlags,
  repository: string,
  interactive: boolean,
): Promise<TaskSpec> {
  if (flags.issue) {
    const issue = parseIssueRef(flags.issue, flags.repo ?? repository);
    return { kind: 'issue', repo: issue.repo, number: issue.number };
  }
  if (flags.taskFile) {
    return {
      kind: 'prompt',
      prompt: readTaskFile(flags.taskFile, deps.cwd()),
      ...(flags.title ? { title: flags.title } : {}),
    };
  }
  if (flags.task) {
    return { kind: 'prompt', prompt: flags.task, ...(flags.title ? { title: flags.title } : {}) };
  }
  if (!interactive) {
    throw new CliError('a task is required: pass --task "…", --task-file <path> or --issue owner/name#123');
  }
  const kind = await deps.prompter.select<'prompt' | 'issue'>({
    message: 'What is the task?',
    options: [
      { value: 'prompt', label: 'a prompt I type now' },
      { value: 'issue', label: 'a GitHub issue' },
    ],
  });
  if (requireValue(kind, 'the task was chosen') === 'issue') {
    const answer = await deps.prompter.text({
      message: 'Issue (owner/name#123)',
      validate: (value) => (value.trim().length === 0 ? 'required' : undefined),
    });
    const issue = parseIssueRef(requireValue(answer, 'the task was chosen'), repository);
    return { kind: 'issue', repo: issue.repo, number: issue.number };
  }
  const answer = await deps.prompter.text({
    message: 'Task for both sides (they receive it verbatim)',
    validate: (value) => (value.trim().length === 0 ? 'required' : undefined),
  });
  return { kind: 'prompt', prompt: requireValue(answer, 'the task was written').trim() };
}

async function resolveLimits(
  deps: CliDeps,
  flags: BattleFlags,
  interactive: boolean,
): Promise<{ timeoutMs?: number; maxTurns?: number; maxBudgetUsd?: number }> {
  const limits: { timeoutMs?: number; maxTurns?: number; maxBudgetUsd?: number } = {};
  if (flags.timeout) limits.timeoutMs = parseDuration(flags.timeout);
  else if (interactive) {
    const answer = await deps.prompter.text({
      message: 'Timeout per side',
      placeholder: '20m',
      defaultValue: '20m',
      initialValue: '20m',
    });
    limits.timeoutMs = parseDuration(requireValue(answer, 'the limits were set'));
  }
  if (flags.maxTurns) limits.maxTurns = parsePositiveInt(flags.maxTurns, '--max-turns');
  if (flags.maxBudgetUsd) limits.maxBudgetUsd = parsePositiveNumber(flags.maxBudgetUsd, '--max-budget-usd');
  return limits;
}

export interface BuildSpecInput {
  harnessA: string;
  harnessB: string;
  agentA: string;
  agentB: string;
  modelA?: string;
  modelB?: string;
  labelA?: string;
  labelB?: string;
  repository: string;
  ref?: string;
  task: TaskSpec;
  tests?: string;
  build?: string[];
  limits: { timeoutMs?: number; maxTurns?: number; maxBudgetUsd?: number };
  parallel: boolean;
  trusted: boolean;
  upload: UploadLevel;
  exclude: PrivacyExclusion[];
  visibility?: string;
  title?: string;
  category?: string;
}

/** Flags in, spec out. Pure, so a test can assert exactly what the engine will receive. */
export function buildBattleSpec(input: BuildSpecInput): BattleSpec {
  const spec: BattleSpecInput = {
    version: 1,
    ...(input.title ? { title: input.title } : {}),
    task: input.task,
    repository: { source: input.repository, ...(input.ref ? { ref: input.ref } : {}) },
    competitors: {
      a: {
        ...(input.labelA ? { label: input.labelA } : {}),
        agent: { id: input.agentA, ...(input.modelA ? { model: input.modelA } : {}) },
        harness: { source: input.harnessA, trusted: input.trusted },
      },
      b: {
        ...(input.labelB ? { label: input.labelB } : {}),
        agent: { id: input.agentB, ...(input.modelB ? { model: input.modelB } : {}) },
        harness: { source: input.harnessB, trusted: input.trusted },
      },
    },
    limits: input.limits,
    evaluation: {
      ...(input.tests ? { tests: { command: input.tests } } : {}),
      ...(input.build && input.build.length > 0 ? { build: input.build } : {}),
    },
    privacy: { upload: input.upload, exclude: input.exclude },
    parallel: input.parallel,
    ...(input.visibility ? { visibility: parseVisibility(input.visibility) } : {}),
    ...(input.category ? { category: input.category } : {}),
  };
  return parseSpec(spec, 'the battle');
}

function firstLine(text: string, max = 72): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

function printSummary(ui: Ui, spec: BattleSpec): void {
  ui.heading('Battle');
  for (const side of ['a', 'b'] as const) {
    const competitor = spec.competitors[side];
    ui.detail(
      side.toUpperCase() + '  ' + sideLabel(spec, side),
      'agent ' +
        competitor.agent.id +
        (competitor.agent.model ? ' (' + competitor.agent.model + ')' : '') +
        '  harness ' +
        competitor.harness.source,
      22,
    );
  }
  ui.detail(
    'Repository',
    spec.repository.source + (spec.repository.ref ? ' @ ' + spec.repository.ref : ''),
    22,
  );
  ui.detail(
    'Task',
    spec.task.kind === 'prompt'
      ? firstLine(spec.task.prompt)
      : spec.task.repo + '#' + String(spec.task.number),
    22,
  );
  const limits = [
    'timeout ' + String(Math.round(spec.limits.timeoutMs / 60_000)) + 'm',
    ...(spec.limits.maxTurns ? ['max turns ' + String(spec.limits.maxTurns)] : []),
    ...(spec.limits.maxBudgetUsd ? ['max budget $' + String(spec.limits.maxBudgetUsd)] : []),
  ];
  ui.detail('Limits', limits.join(', '), 22);
  ui.detail('Tests', spec.evaluation.tests ? spec.evaluation.tests.command : 'none configured', 22);
  ui.detail(
    'Upload',
    spec.privacy.upload === 'none'
      ? 'nothing leaves this machine'
      : spec.privacy.upload +
          (spec.privacy.exclude.length > 0 ? ' (excluding ' + spec.privacy.exclude.join(', ') + ')' : ''),
    22,
  );
  ui.detail('Execution', spec.parallel ? 'both sides in parallel' : 'one side at a time', 22);
}

/**
 * The disclosure step: for each side, the harness files that will be copied into the workspace and
 * every command the harness declares. Trust is asked for here, before anything runs.
 */
async function disclose(
  deps: CliDeps,
  ui: Ui,
  spec: BattleSpec,
  home: string,
  interactive: boolean,
): Promise<void> {
  ui.heading('What will be applied');
  for (const side of ['a', 'b'] as const) {
    const competitor = spec.competitors[side];
    const source = competitor.harness.source;
    if (source.trim() === VANILLA) {
      ui.line('  ' + side.toUpperCase() + '  vanilla: no harness files, the agent uses its own defaults');
      continue;
    }
    const resolved = await resolveHarnessForCli(deps, source, {
      home,
      agentId: competitor.agent.id,
      ...(competitor.harness.ref ? { ref: competitor.harness.ref } : {}),
      trusted: competitor.harness.trusted,
    });
    const execution = describeExecution(resolved);
    ui.line(
      '  ' +
        side.toUpperCase() +
        '  ' +
        resolved.name +
        (resolved.commit ? ' @ ' + resolved.commit.slice(0, 12) : '') +
        '  ' +
        ui.c.dim(resolved.inspection.compatibility.status),
    );
    if (execution.files.length === 0) ui.line('      ' + ui.c.dim('no files to copy'));
    for (const file of execution.files.slice(0, 12)) ui.line('      ' + ui.sym.dot + ' ' + file);
    if (execution.files.length > 12) {
      ui.line('      ' + ui.c.dim('... and ' + String(execution.files.length - 12) + ' more'));
    }
    if (execution.commands.length > 0) {
      ui.line('      ' + ui.c.bold('commands this harness declares:'));
      for (const command of execution.commands) ui.line('      $ ' + command);
      if (!competitor.harness.trusted) {
        if (!interactive) {
          throw new CliError(
            'harness ' +
              resolved.name +
              ' declares ' +
              String(execution.commands.length) +
              ' command(s). Re-run with --trust to allow them.',
            3,
          );
        }
        const approved = await deps.prompter.confirm({
          message: 'Allow these commands to run on your machine for side ' + side.toUpperCase() + '?',
          initialValue: false,
        });
        if (approved !== true) {
          throw new CliError('the harness was not trusted, so the battle did not run.', 3);
        }
        competitor.harness.trusted = true;
      }
    }
  }
}

/** `arena battle [harnessA] [harnessB]` */
export async function battleCommand(
  deps: CliDeps,
  harnessAArg: string | undefined,
  harnessBArg: string | undefined,
  flags: BattleFlags,
): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);
  const config = await store.getConfig();
  const interactive = ui.tty && flags.yes !== true;

  const rows = await collectAgentRows(deps);
  const recents = recentHarnesses(config);

  let harnessA = harnessAArg?.trim();
  let harnessB = harnessBArg?.trim();
  if (!harnessA || !harnessB) {
    if (!interactive) {
      throw new CliError(
        'name both harnesses: `arena battle <harnessA> <harnessB>` (use "vanilla" for the agent defaults).',
      );
    }
    deps.prompter.intro('Harness Arena');
    harnessA = harnessA ?? (await pickHarness(deps, 'a', recents));
    harnessB =
      harnessB ??
      (await pickHarness(
        deps,
        'b',
        recents.filter((source) => source !== harnessA),
      ));
  }

  let agentA = flags.agentA ?? flags.agent;
  let agentB = flags.agentB ?? flags.agent;
  if (!agentA || !agentB) {
    if (interactive) {
      const picked = await pickAgent(deps, rows);
      agentA = agentA ?? picked;
      agentB = agentB ?? picked;
    } else {
      throw new CliError(
        '--agent <id> is required (or --agent-a/--agent-b). Installed: ' +
          (rows
            .filter((row) => row.installed)
            .map((row) => row.id)
            .join(', ') || 'none'),
      );
    }
  }
  requireInstalledAgent(rows, agentA);
  requireInstalledAgent(rows, agentB);

  const repository = await resolveRepository(deps, flags, interactive);
  const task = await resolveTask(deps, flags, repository, interactive);
  const limits = await resolveLimits(deps, flags, interactive);

  const upload: UploadLevel =
    flags.localOnly === true
      ? 'none'
      : flags.upload
        ? parseUploadLevel(flags.upload)
        : ((config.defaultPrivacyUpload as UploadLevel | undefined) ?? 'none');

  const spec = buildBattleSpec({
    harnessA,
    harnessB,
    agentA,
    agentB,
    ...((flags.modelA ?? flags.model) ? { modelA: flags.modelA ?? flags.model } : {}),
    ...((flags.modelB ?? flags.model) ? { modelB: flags.modelB ?? flags.model } : {}),
    ...(flags.labelA ? { labelA: flags.labelA } : {}),
    ...(flags.labelB ? { labelB: flags.labelB } : {}),
    repository,
    ...(flags.ref ? { ref: flags.ref } : {}),
    task,
    ...(flags.tests ? { tests: flags.tests } : {}),
    ...(flags.build ? { build: flags.build } : {}),
    limits,
    parallel: flags.parallel === true,
    trusted: flags.trust === true,
    upload,
    exclude: flags.exclude ? parseExclusions(flags.exclude) : [],
    ...(flags.visibility ? { visibility: flags.visibility } : {}),
    ...(flags.title ? { title: flags.title } : {}),
    ...(flags.category ? { category: flags.category } : {}),
  });

  // The disclosure resolves both harnesses to show real files and commands, so it only runs for a
  // human who can answer it. A non-interactive run is gated by the engine's trust callback instead.
  if (interactive) await disclose(deps, ui, spec, home, interactive);
  if (!ui.json) printSummary(ui, spec);

  if (interactive) {
    const go = await deps.prompter.confirm({ message: 'Start the battle?', initialValue: true });
    if (go !== true) throw new CancelledError('No battle was started.');
  }

  await rememberHarnesses(store, [harnessA, harnessB]);

  const outcome = await executeBattle(deps, ui, {
    spec,
    home,
    trust: flags.trust === true,
    localOnly: flags.localOnly === true,
    open: flags.open === true,
    keepWorkspaces: flags.keepWorkspaces === true,
    ...(flags.server ? { serverUrl: flags.server } : {}),
  });
  if (flags.keepWorkspaces === true && !ui.json) {
    ui.detail('Workspaces', path.join(store.paths(outcome.record.id).dir, 'runs'), 8);
  }
  finishBattle(ui, outcome);
}
