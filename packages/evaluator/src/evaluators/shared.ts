import path from 'node:path';
import type { EvaluatorResult, RunArtifacts, Side } from '@harness-arena/protocol';
import { shellInvocation } from '@harness-arena/adapters';
import { createOutputCollector, PROCESS_OUTPUT_CAP_BYTES } from '../run-tests.js';
import type { ProcessRunner } from '../types.js';

export const SIDES: readonly Side[] = ['a', 'b'];

export function makeResult(
  init: Omit<EvaluatorResult, 'durationMs'> & { durationMs?: number },
  startedAt?: number,
): EvaluatorResult {
  const durationMs = init.durationMs ?? (startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt));
  return { ...init, durationMs };
}

export interface ShellOutcome {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  spawnError: string | null;
}

/** Runs one user-authored shell line (see the note on `shellInvocation`) and captures its output. */
export async function runShellCommand(opts: {
  command: string;
  cwd: string;
  timeoutMs: number;
  runner: ProcessRunner;
  signal?: AbortSignal;
  env?: Record<string, string>;
}): Promise<ShellOutcome> {
  const invocation = shellInvocation(opts.command);
  const collector = createOutputCollector();
  const fallback = new AbortController();
  const startedAt = Date.now();
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') base[key] = value;

  const result = await opts.runner.run({
    command: invocation.command,
    args: invocation.args,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    cwd: opts.cwd,
    env: { ...base, ...(opts.env ?? {}) },
    stdin: null,
    signal: opts.signal ?? fallback.signal,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: PROCESS_OUTPUT_CAP_BYTES,
    onStdoutLine: (line) => collector.push(line),
    onStderrLine: (line) => collector.push(line),
  });

  if (result.spawnError) collector.push(`[arena] command could not start: ${result.spawnError}`);
  if (result.timedOut) collector.push(`[arena] command timed out after ${opts.timeoutMs} ms`);

  return {
    exitCode: result.exitCode,
    output: collector.text(),
    durationMs: result.durationMs > 0 ? result.durationMs : Date.now() - startedAt,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
  };
}

/** Rejects paths that escape the workspace (absolute, `..`, drive-relative). */
export function resolveInWorkspace(workspace: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const absolute = path.resolve(workspace, relative);
  const rel = path.relative(workspace, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return absolute;
}

/** Paths the run changed: from `changedFiles` when the engine computed it, else from the diff headers. */
export function changedFilePaths(artifacts: RunArtifacts): string[] {
  if (artifacts.changedFiles.length) return artifacts.changedFiles.map((f) => f.path);
  const diff = artifacts.diff ?? '';
  const paths: string[] = [];
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const a = m[1];
    const b = m[2];
    const picked = b && b !== '/dev/null' ? b : a;
    if (picked) paths.push(picked);
  }
  return [...new Set(paths)];
}

export interface DiffLines {
  added: string[];
  removed: string[];
}

/** Content lines a unified diff adds and removes (file headers excluded). */
export function diffLines(diff: string | null | undefined): DiffLines {
  const added: string[] = [];
  const removed: string[] = [];
  if (!diff) return { added, removed };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

export function countedLines(artifacts: RunArtifacts): { added: number; removed: number } {
  if (artifacts.changedFiles.length) {
    return {
      added: artifacts.changedFiles.reduce((n, f) => n + f.linesAdded, 0),
      removed: artifacts.changedFiles.reduce((n, f) => n + f.linesRemoved, 0),
    };
  }
  const lines = diffLines(artifacts.diff);
  return { added: lines.added.length, removed: lines.removed.length };
}
