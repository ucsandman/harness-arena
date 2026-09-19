import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { AgentConfig } from '@harness-arena/protocol';
import { resolveInside, toPosix } from './file-source.js';
import type { ResolvedHarness } from './resolve.js';
import type { Logger, ProcessRunner } from './types.js';

/**
 * Laying a resolved harness into a battle workspace. Files are copied with containment and symlink
 * checks; the repository's own files always win a collision (except the root CLAUDE.md, which is moved
 * aside into .claude/). Manifest commands run only after the user has trusted the harness.
 */

export interface ApplyOptions {
  /** absolute path of the run workspace (a git worktree owned by Arena) */
  workspace: string;
  agentId: string;
  /** the user has approved the harness's install/prepare commands */
  trusted: boolean;
  runner: ProcessRunner;
  /** base environment for manifest commands */
  env: Record<string, string>;
  logger: Logger;
  signal?: AbortSignal;
}

export interface ApplyResult {
  /** workspace-relative paths written by the harness */
  appliedFiles: string[];
  executedCommands: string[];
  agentConfig: AgentConfig | null;
}

export type HarnessApplyErrorCode = 'no_directory' | 'command_failed' | 'agent_config' | 'workspace_escape';

export class HarnessApplyError extends Error {
  readonly code: HarnessApplyErrorCode;
  constructor(code: HarnessApplyErrorCode, message: string) {
    super(message);
    this.name = 'HarnessApplyError';
    this.code = code;
  }
}

export class HarnessTrustRequiredError extends Error {
  readonly commands: string[];
  constructor(commands: string[]) {
    super(
      `this harness wants to run ${commands.length} command(s) on your machine; re-run with trust granted to allow: ${commands.join(' && ')}`,
    );
    this.name = 'HarnessTrustRequiredError';
    this.commands = commands;
  }
}

export interface PlannedCommand {
  phase: 'install' | 'prepare' | 'cleanup';
  command: string;
  timeoutMs: number;
  /** null when the harness has no directory (nothing to install in) */
  cwd: string | null;
}

const COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024;

function platformAllows(platforms: readonly string[] | undefined): boolean {
  return platforms === undefined || platforms.includes(process.platform);
}

/** Commands this harness would run on this platform, in execution order. */
export function plannedCommands(h: ResolvedHarness): PlannedCommand[] {
  const manifest = h.manifest;
  if (!manifest) return [];
  const workspacePhases: Array<PlannedCommand['phase']> = ['prepare', 'cleanup'];
  const out: PlannedCommand[] = [];
  for (const phase of ['install', 'prepare', 'cleanup'] as const) {
    const entry = manifest[phase];
    if (!entry || !platformAllows(entry.platforms)) continue;
    out.push({
      phase,
      command: entry.command,
      timeoutMs: entry.timeoutMs,
      // install runs in the harness checkout, prepare/cleanup in the workspace (filled in by applyHarness)
      cwd: workspacePhases.includes(phase) ? null : h.dir,
    });
  }
  return out;
}

/** Exactly what Arena would execute and copy, for the disclosure shown before trust is granted. */
export function describeExecution(h: ResolvedHarness): { commands: string[]; files: string[] } {
  return {
    commands: plannedCommands(h).map((c) => c.command),
    files: h.manifest?.files ?? h.inspection.applyFiles,
  };
}

function looksLikePathValue(value: string): boolean {
  return /\.(md|txt)$/i.test(value.trim()) && !/[\r\n]/.test(value);
}

/** Resolve the per-agent config, turning harness-relative file references into absolute paths. */
export function resolveAgentConfig(h: ResolvedHarness, agentId: string): AgentConfig | null {
  const raw = h.manifest?.agentConfig?.[agentId];
  if (!raw) return null;
  const dir = h.dir;
  const resolveRef = (label: string, value: string): string => {
    if (dir === null) {
      throw new HarnessApplyError(
        'agent_config',
        `${label} references a file but this harness has no directory`,
      );
    }
    const abs = resolveInside(dir, value);
    if (abs === null) {
      throw new HarnessApplyError('agent_config', `${label} escapes the harness directory: ${value}`);
    }
    return abs;
  };

  const out: AgentConfig = { ...raw };
  if (raw.settings) out.settings = resolveRef('agentConfig.settings', raw.settings);
  if (raw.mcpConfig) out.mcpConfig = resolveRef('agentConfig.mcpConfig', raw.mcpConfig);
  if (raw.systemPromptAppend && looksLikePathValue(raw.systemPromptAppend)) {
    out.systemPromptAppend = resolveRef('agentConfig.systemPromptAppend', raw.systemPromptAppend);
  }
  return out;
}

async function lstatOrNull(p: string): Promise<{ isFile: boolean; isDir: boolean; isLink: boolean } | null> {
  try {
    const st = await fs.lstat(p);
    return { isFile: st.isFile(), isDir: st.isDirectory(), isLink: st.isSymbolicLink() };
  } catch {
    return null;
  }
}

export async function applyHarness(h: ResolvedHarness, opts: ApplyOptions): Promise<ApplyResult> {
  const logger = opts.logger.child({ component: 'harness/apply', harness: h.name });
  const workspace = path.resolve(opts.workspace);
  const appliedFiles: string[] = [];
  const executedCommands: string[] = [];

  const commands = plannedCommands(h).filter((c) => c.phase !== 'cleanup');
  if (commands.length > 0 && !opts.trusted) {
    throw new HarnessTrustRequiredError(commands.map((c) => c.command));
  }

  // ---- files ----------------------------------------------------------------------------------
  const targetRel = h.manifest?.target ?? '.';
  let targetRoot = workspace;
  if (targetRel !== '.' && targetRel !== '' && targetRel !== './') {
    const resolved = resolveInside(workspace, targetRel);
    if (resolved === null) {
      throw new HarnessApplyError('workspace_escape', `manifest target escapes the workspace: ${targetRel}`);
    }
    targetRoot = resolved;
  }

  const declared = h.manifest?.files ?? h.inspection.applyFiles;
  if (declared.length > 0 && h.dir === null) {
    logger.debug('harness declares files but has no directory; nothing to copy', { count: declared.length });
  }

  const harnessDir = h.dir;
  if (harnessDir !== null) {
    await fs.mkdir(targetRoot, { recursive: true });
    for (const rel of declared) {
      const src = resolveInside(harnessDir, rel);
      if (src === null) {
        logger.warn('refused harness path: not relative, or escapes the harness directory', { path: rel });
        continue;
      }
      const st = await lstatOrNull(src);
      if (st === null) {
        logger.debug('harness path declared but not present', { path: rel });
        continue;
      }
      if (st.isLink) {
        logger.warn('skipped symlink declared by the harness', { path: rel });
        continue;
      }
      if (st.isDir) await copyDirectory(src, rel);
      else if (st.isFile) await copyOne(src, rel);
    }
  }

  async function copyDirectory(srcDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(srcDir, { withFileTypes: true });
    } catch {
      logger.warn('could not read harness directory', { path: relDir });
      return;
    }
    for (const entry of entries) {
      const rel = `${relDir.replace(/[/\\]+$/, '')}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        logger.warn('skipped symlink inside the harness', { path: rel });
        continue;
      }
      const abs = path.join(srcDir, entry.name);
      if (entry.isDirectory()) await copyDirectory(abs, rel);
      else if (entry.isFile()) await copyOne(abs, rel);
    }
  }

  async function copyOne(srcFile: string, rel: string): Promise<void> {
    const dest = resolveInside(targetRoot, rel);
    if (dest === null || resolveInside(workspace, toPosix(path.relative(workspace, dest))) === null) {
      logger.warn('refused to write outside the workspace', { path: rel });
      return;
    }
    const existing = await lstatOrNull(dest);
    if (existing !== null) {
      // a root CLAUDE.md the repository already owns: put the harness one where Claude Code also reads it
      if (targetRoot === workspace && rel.toLowerCase() === 'claude.md') {
        const altRel = '.claude/CLAUDE.md';
        const alt = resolveInside(workspace, altRel) as string;
        if ((await lstatOrNull(alt)) !== null) {
          logger.warn(
            'workspace already has CLAUDE.md and .claude/CLAUDE.md; kept both repository versions',
            {
              path: rel,
            },
          );
          return;
        }
        await fs.mkdir(path.dirname(alt), { recursive: true });
        await fs.copyFile(srcFile, alt);
        logger.info('workspace already had CLAUDE.md; harness CLAUDE.md applied as .claude/CLAUDE.md', {
          path: altRel,
        });
        appliedFiles.push(`${altRel} (from ${rel})`);
        return;
      }
      logger.warn('kept the repository version of a file the harness also provides', {
        path: toPosix(path.relative(workspace, dest)),
      });
      return;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(srcFile, dest);
    appliedFiles.push(toPosix(path.relative(workspace, dest)));
  }

  // ---- commands -------------------------------------------------------------------------------
  const shell =
    process.platform === 'win32'
      ? { command: 'cmd.exe', args: ['/d', '/s', '/c'] }
      : { command: 'sh', args: ['-c'] };
  const env: Record<string, string> = {
    ...opts.env,
    ARENA_WORKSPACE: workspace,
    ARENA_HARNESS_DIR: harnessDir ?? '',
    ARENA_AGENT: opts.agentId,
  };
  const signal = opts.signal ?? new AbortController().signal;

  for (const planned of commands) {
    const cwd = planned.phase === 'install' ? planned.cwd : workspace;
    if (cwd === null) {
      logger.warn('skipped harness command: no harness directory to run it in', { phase: planned.phase });
      continue;
    }
    logger.info('running harness command', { phase: planned.phase, command: planned.command, cwd });
    const result = await opts.runner.run({
      command: shell.command,
      args: [...shell.args, planned.command],
      cwd,
      env,
      stdin: null,
      signal,
      timeoutMs: planned.timeoutMs,
      maxOutputBytes: COMMAND_OUTPUT_LIMIT,
      onStdoutLine: (line) => logger.debug('harness command output', { phase: planned.phase, line }),
      onStderrLine: (line) => logger.debug('harness command stderr', { phase: planned.phase, line }),
    });
    if (result.spawnError !== null) {
      throw new HarnessApplyError(
        'command_failed',
        `harness ${planned.phase} command could not start: ${result.spawnError}`,
      );
    }
    if (result.timedOut) {
      throw new HarnessApplyError(
        'command_failed',
        `harness ${planned.phase} command timed out after ${planned.timeoutMs}ms: ${planned.command}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new HarnessApplyError(
        'command_failed',
        `harness ${planned.phase} command exited ${result.exitCode}: ${planned.command}`,
      );
    }
    executedCommands.push(planned.command);
  }

  logger.debug('harness applied', { files: appliedFiles.length, commands: executedCommands.length });
  return { appliedFiles, executedCommands, agentConfig: resolveAgentConfig(h, opts.agentId) };
}
