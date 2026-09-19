/**
 * Structural mirrors of the injected interfaces owned by `@harness-arena/adapters`.
 *
 * This package must typecheck on its own (the adapters implementation is written in parallel and its
 * barrel does not export these yet), so the shapes are declared here. They are structurally identical
 * to the adapters ones, which means an adapters `Logger` / `ProcessRunner` can be passed straight in.
 */

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string | null;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  onStdoutLine: (line: string) => void;
  onStderrLine: (line: string) => void;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  outputBytes: number;
  truncated: boolean;
  durationMs: number;
  spawnError: string | null;
}

export interface ProcessRunner {
  run(opts: ProcessRunOptions): Promise<ProcessRunResult>;
}

/** Injected git invoker, so resolution can be tested without touching the network. */
export type GitRunner = (args: string[], cwd?: string) => Promise<{ stdout: string; exitCode: number }>;

/** A logger that drops everything; used as a default so callers are not forced to pass one. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
