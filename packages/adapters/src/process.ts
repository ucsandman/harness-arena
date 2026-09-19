import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { execa } from 'execa';
import which from 'which';
import type { ProcessRunOptions, ProcessRunResult, ProcessRunner } from './types.js';

/**
 * The real process runner. Every agent CLI is spawned with an argument array (never a shell string),
 * the prompt is written to stdin, and output is delivered line by line so events stream live.
 *
 * npm CLI shims on Windows are `.cmd` files; execa resolves them through cross-spawn, so `shell`
 * stays off and nothing the user typed is ever interpreted by a shell.
 */

const SPAWN_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EINVAL', 'E2BIG', 'UNKNOWN']);
const FORCE_KILL_GRACE_MS = 4000;

/** Splits a byte stream into lines, tolerating CRLF and chunk boundaries inside a line. */
export class LineSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (!this.buffer.includes('\n')) return [];
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    return parts.map(stripCr);
  }

  /** Remaining partial line, if the process ended without a trailing newline. */
  flush(): string | null {
    if (!this.buffer) return null;
    const rest = stripCr(this.buffer);
    this.buffer = '';
    return rest;
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', done);
      child.once('close', done);
    } catch {
      done();
    }
  });
}

/**
 * Kill a process and everything it spawned. Agent CLIs shell out constantly, so killing only the
 * direct child leaves test runners and language servers alive.
 *
 * Windows: `taskkill /T /F` (there is no process group to signal).
 * POSIX: signal the process group (the child is a group leader because it was spawned detached),
 * falling back to the pid itself, then to SIGKILL.
 */
export async function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await taskkill(pid);
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // no process group (not detached) or already gone
  }
  try {
    process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Resolve the command to an absolute path before spawning.
 *
 * On Windows, cross-spawn runs a non-`.exe` command through `cmd.exe`, so a missing CLI comes back
 * as exit code 1 with "'x' is not recognized as an internal or external command" instead of ENOENT.
 * Resolving first makes "not installed" the same observable result on every platform.
 */
async function resolveExecutable(command: string, env: Record<string, string>): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? env.path;
  const pathExt = env.PATHEXT ?? env.Pathext;
  try {
    const found = await which(command, {
      nothrow: true,
      ...(pathValue === undefined ? {} : { path: pathValue }),
      ...(pathExt === undefined ? {} : { pathExt }),
    });
    return found ?? null;
  } catch {
    return null;
  }
}

export async function runProcess(opts: ProcessRunOptions): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  if (opts.signal.aborted) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      outputBytes: 0,
      truncated: false,
      durationMs: 0,
      spawnError: null,
    };
  }

  const isWindows = process.platform === 'win32';
  let outputBytes = 0;
  let truncated = false;
  let timedOut = false;
  let aborted = false;

  const executable = await resolveExecutable(opts.command, opts.env);
  if (executable === null) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      outputBytes: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
      spawnError: `ENOENT: ${opts.command} could not be found on PATH`,
    };
  }

  const subprocess = execa(executable, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: false,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
    encoding: 'utf8',
    // POSIX: make the child a process-group leader so the whole tree can be signalled.
    detached: !isWindows,
    windowsHide: true,
  });

  let forceTimer: NodeJS.Timeout | null = null;
  let killed = false;
  const killTree = () => {
    if (killed) return;
    killed = true;
    const pid = subprocess.pid;
    if (pid === undefined) {
      subprocess.kill('SIGKILL');
      return;
    }
    void killProcessTree(pid, isWindows ? 'SIGKILL' : 'SIGTERM');
    if (!isWindows) {
      forceTimer = setTimeout(() => void killProcessTree(pid, 'SIGKILL'), FORCE_KILL_GRACE_MS);
      forceTimer.unref();
    }
  };

  const onAbort = () => {
    aborted = true;
    killTree();
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });

  const timeoutTimer =
    opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree();
        }, opts.timeoutMs)
      : null;
  timeoutTimer?.unref();

  const attach = (stream: Readable | null, onLine: (line: string) => void) => {
    if (!stream) return;
    const splitter = new LineSplitter();
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (truncated) return;
      for (const line of splitter.push(chunk)) onLine(line);
      if (outputBytes > opts.maxOutputBytes) {
        truncated = true;
        killTree();
      }
    });
    stream.on('end', () => {
      if (truncated) return;
      const rest = splitter.flush();
      if (rest !== null && rest.length > 0) onLine(rest);
    });
    // A killed process can tear a pipe down mid-write; that is not a run failure.
    stream.on('error', () => {});
  };

  attach(subprocess.stdout as unknown as Readable | null, opts.onStdoutLine);
  attach(subprocess.stderr as unknown as Readable | null, opts.onStderrLine);

  const stdin = subprocess.stdin as unknown as Writable | null;
  if (stdin) {
    stdin.on('error', () => {}); // EPIPE when the CLI exits before reading the prompt
    if (opts.stdin !== null && opts.stdin !== undefined) stdin.write(opts.stdin);
    stdin.end();
  }

  const result = await subprocess;

  opts.signal.removeEventListener('abort', onAbort);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (forceTimer) clearTimeout(forceTimer);

  const code = typeof result.code === 'string' ? result.code : undefined;
  const spawnError =
    code && SPAWN_ERROR_CODES.has(code)
      ? `${code}: ${result.originalMessage ?? result.shortMessage ?? `could not spawn ${opts.command}`}`
      : null;

  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    signal: result.signal ?? null,
    timedOut,
    aborted,
    outputBytes,
    truncated,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : Date.now() - startedAt,
    spawnError,
  };
}

export const defaultProcessRunner: ProcessRunner = { run: runProcess };
