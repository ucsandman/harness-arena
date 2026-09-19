import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalFileSource, inspectHarness, parseHarnessSource } from '@harness-arena/harness';
import type { HarnessInspection } from '@harness-arena/protocol';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import type { Ui } from '../ui.js';
import { resolveHome } from '../config.js';
import { CancelledError } from '../errors.js';
import { agentMark, collectAgentRows } from './agents.js';
import { battleCommand } from './battle.js';
import { demoCommand } from './demo.js';
import { doctorCommand } from './doctor.js';
import { harnessInspectCommand } from './harnesses.js';

export interface WelcomeFlags {
  home?: string;
}

const BANNER = ['  ██╗  ██╗  Harness Arena', '  ██╔══██╗ battle two agent harnesses on the same task'].join(
  '\n',
);

/** Harness configuration that exists in the working directory right now. */
export async function inspectCwd(deps: CliDeps): Promise<HarnessInspection | null> {
  const cwd = deps.cwd();
  try {
    return await inspectHarness(parseHarnessSource(cwd), createLocalFileSource(cwd));
  } catch {
    return null;
  }
}

function printDetectedHarness(
  ui: Ui,
  inspection: HarnessInspection | null,
  userClaudeDir: string | null,
): void {
  ui.heading('Detected harness configuration here');
  const detected = inspection ? inspection.features.filter((feature) => feature.detected) : [];
  if (userClaudeDir) {
    ui.line(
      '  ' +
        ui.c.green(ui.sym.ok) +
        ' ~/.claude  ' +
        ui.c.dim('user-level Claude Code config (excluded from battles where the CLI allows it)'),
    );
  }
  if (detected.length === 0) {
    ui.line('  ' + ui.c.dim(ui.sym.no + ' nothing in this directory: a battle here would run vanilla'));
    return;
  }
  for (const feature of detected) {
    const count = typeof feature.count === 'number' ? feature.count : feature.paths.length;
    ui.line(
      '  ' +
        ui.c.green(ui.sym.ok) +
        ' ' +
        feature.label.padEnd(18) +
        (count > 0 ? String(count) + (count === 1 ? ' file' : ' files') : '') +
        (feature.paths[0] ? '  ' + ui.c.dim(feature.paths[0]) : ''),
    );
  }
}

/**
 * `arena` with no arguments on a terminal: what is installed, what is here, and a menu. Non-TTY
 * prints help instead (handled in program.ts), because a menu no one can answer is a hang.
 */
export async function welcomeCommand(deps: CliDeps, flags: WelcomeFlags): Promise<void> {
  const ui = createUi(deps);
  const home = resolveHome(deps, flags.home);

  ui.line();
  ui.line(ui.c.bold(BANNER));
  ui.line();
  ui.line(ui.c.dim('  arena ' + deps.arenaVersion + '   home ' + home));

  const rows = await collectAgentRows(deps);
  ui.heading('Detected agents');
  const nameWidth = Math.max(16, ...rows.map((row) => row.displayName.length + 2));
  for (const row of rows) {
    const state = row.installed
      ? (row.version ?? 'installed') + ', auth ' + row.auth
      : ui.c.dim('not installed');
    ui.line('  ' + agentMark(ui, row) + ' ' + row.displayName.padEnd(nameWidth) + state);
  }
  const installed = rows.filter((row) => row.installed && row.id !== 'fake');
  if (installed.length === 0) {
    ui.line();
    ui.line(
      ui.c.dim('  No real agent CLI found. `arena demo` works anyway: it replays deterministic fixtures.'),
    );
  }

  const userClaude = path.join(os.homedir(), '.claude');
  printDetectedHarness(ui, await inspectCwd(deps), fs.existsSync(userClaude) ? userClaude : null);

  const choice = await deps.prompter.select<'battle' | 'demo' | 'inspect' | 'doctor' | 'exit'>({
    message: 'What would you like to do?',
    options: [
      { value: 'battle', label: 'Run a battle', hint: 'two harnesses, one task' },
      { value: 'demo', label: 'Run the demo', hint: 'deterministic, no agent CLI needed' },
      { value: 'inspect', label: 'Inspect a harness', hint: 'compatibility report, nothing executed' },
      { value: 'doctor', label: 'Doctor', hint: 'environment and leftovers' },
      { value: 'exit', label: 'Exit' },
    ],
    initialValue: installed.length === 0 ? 'demo' : 'battle',
  });

  switch (choice) {
    case 'battle':
      await battleCommand(deps, undefined, undefined, { ...(flags.home ? { home: flags.home } : {}) });
      return;
    case 'demo':
      await demoCommand(deps, { ...(flags.home ? { home: flags.home } : {}) });
      return;
    case 'inspect': {
      const source = await deps.prompter.text({
        message: 'Harness to inspect (GitHub URL or local path)',
        placeholder: '.',
        defaultValue: '.',
        initialValue: '.',
      });
      if (source === null) throw new CancelledError();
      await harnessInspectCommand(deps, source.trim(), { ...(flags.home ? { home: flags.home } : {}) });
      return;
    }
    case 'doctor':
      await doctorCommand(deps, { ...(flags.home ? { home: flags.home } : {}) });
      return;
    default:
      ui.line('Bye.');
      return;
  }
}
