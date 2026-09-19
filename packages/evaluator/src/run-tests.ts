import { parseTestOutput } from './test-parsers.js';
import type { ProcessRunner, TestOutcome, TestParser } from './types.js';

/** Captured output kept per test run. The tail is kept, because runners print their summary last. */
export const OUTPUT_CAP_BYTES = 512 * 1024;
/** How much the child process may write before the runner kills it. */
export const PROCESS_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

const TRUNCATION_RESERVE = 200;

/**
 * Test commands come from `arena.yaml` / the battle spec as a single user-authored shell line
 * (`npm test -- --run`, `pytest -q && echo done`). Arena therefore runs them through the platform
 * shell: `cmd.exe /d /s /c <line>` on Windows, `sh -c <line>` elsewhere. Nothing is interpolated into
 * the line by Arena; the line is passed as one argument, exactly as the user wrote it. Agent prompts
 * and agent CLIs are never invoked this way (adapters use fixed argv, see PreparedRun).
 */
export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { command: 'sh', args: ['-c', command] };
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = text.slice(0, maxBytes);
  while (out.length > 0 && Buffer.byteLength(out) > maxBytes)
    out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

export interface OutputCollector {
  push(line: string): void;
  text(): string;
}

/** Keeps at most `cap` bytes of output, dropping the oldest lines first. */
export function createOutputCollector(cap: number = OUTPUT_CAP_BYTES): OutputCollector {
  const limit = Math.max(cap - TRUNCATION_RESERVE, 1);
  const lines: string[] = [];
  let bytes = 0;
  let dropped = 0;
  return {
    push(line: string) {
      const kept = truncateToBytes(line, limit);
      lines.push(kept);
      bytes += Buffer.byteLength(kept) + 1;
      while (bytes > limit && lines.length > 1) {
        const first = lines.shift();
        if (first === undefined) break;
        bytes -= Buffer.byteLength(first) + 1;
        dropped += 1;
      }
    },
    text() {
      const body = lines.join('\n');
      if (!dropped) return body;
      return `[arena] output truncated: ${dropped} earlier line(s) dropped\n${body}`;
    },
  };
}

export interface RunTestsOptions {
  /** a shell line, run verbatim through the platform shell */
  command: string;
  /** absolute path the command runs in */
  cwd: string;
  parser: TestParser;
  timeoutMs: number;
  runner: ProcessRunner;
  signal?: AbortSignal;
  /** extra variables layered on top of the current process environment */
  env?: Record<string, string>;
}

function processEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') base[key] = value;
  return { ...base, ...(extra ?? {}) };
}

/**
 * Runs a test command and parses its output. Deterministic: no retries, no heuristics beyond the
 * parser, and counts stay `null` when the tool did not report them.
 */
export async function runTests(opts: RunTestsOptions): Promise<TestOutcome> {
  const invocation = shellInvocation(opts.command);
  const collector = createOutputCollector();
  const fallbackController = new AbortController();
  const startedAt = Date.now();

  const result = await opts.runner.run({
    command: invocation.command,
    args: invocation.args,
    cwd: opts.cwd,
    env: processEnv(opts.env),
    stdin: null,
    signal: opts.signal ?? fallbackController.signal,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: PROCESS_OUTPUT_CAP_BYTES,
    onStdoutLine: (line) => collector.push(line),
    onStderrLine: (line) => collector.push(line),
  });

  if (result.spawnError) collector.push(`[arena] test command could not start: ${result.spawnError}`);
  if (result.timedOut) collector.push(`[arena] test command timed out after ${opts.timeoutMs} ms`);
  if (result.aborted) collector.push('[arena] test command was aborted');

  const output = collector.text();
  const parsed = parseTestOutput(output, opts.parser);
  const measured = Date.now() - startedAt;

  return {
    exitCode: result.exitCode,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped,
    total: parsed.total,
    durationMs: result.durationMs > 0 ? result.durationMs : measured,
    parser: parsed.parser,
    output,
    failingTests: parsed.failingTests,
  };
}
