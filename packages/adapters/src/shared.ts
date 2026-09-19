import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EVENT_LIMITS } from '@harness-arena/protocol';
import type { AgentConfig, AgentRef, Side, Usage } from '@harness-arena/protocol';
import type {
  AdapterResult,
  AdapterRunStatus,
  ExecuteContext,
  Logger,
  PreparedRun,
  StreamParser,
} from './types.js';

// ---- json ------------------------------------------------------------------------------------

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string };

/** Never throws: provider streams interleave prose with JSON lines. */
export function parseJsonLine(line: string): JsonParse {
  const trimmed = line.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return { ok: false, error: 'not json' };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Narrow an unknown parsed line to a record without reaching for `any`. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(source: Record<string, unknown> | null, key: string): string | undefined {
  const v = source?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function readNumber(source: Record<string, unknown> | null, key: string): number | undefined {
  const v = source?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function readBoolean(source: Record<string, unknown> | null, key: string): boolean | undefined {
  const v = source?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

export function readArray(source: Record<string, unknown> | null, key: string): unknown[] {
  const v = source?.[key];
  return Array.isArray(v) ? v : [];
}

export function readRecord(
  source: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return asRecord(source?.[key]);
}

// ---- truncation ------------------------------------------------------------------------------

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

/** Truncate to a UTF-8 byte budget. Oversized strings are cut, never dropped. */
export function truncateText(value: string, maxBytes: number = EVENT_LIMITS.maxStringBytes): TruncatedText {
  const buf = Buffer.from(value, 'utf8');
  if (buf.byteLength <= maxBytes) return { text: value, truncated: false };
  // A cut inside a code point renders as U+FFFD, which is acceptable for telemetry text.
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/** Render an unknown provider value as text (tool results are strings, block arrays, or objects). */
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const rec = asRecord(item);
        if (rec && typeof rec.text === 'string') return rec.text;
        return textOf(item);
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Truncate every string inside a tool input so one huge file body cannot blow the event cap.
 * Structure is preserved; only strings shrink.
 */
export function truncateValue(
  value: unknown,
  maxBytes: number = EVENT_LIMITS.maxStringBytes,
): { value: unknown; truncated: boolean } {
  let truncated = false;
  const walk = (input: unknown, depth: number): unknown => {
    if (typeof input === 'string') {
      const t = truncateText(input, maxBytes);
      if (t.truncated) truncated = true;
      return t.text;
    }
    if (depth >= 8) return input;
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));
    const rec = asRecord(input);
    if (!rec) return input;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = walk(v, depth + 1);
    return out;
  };
  return { value: walk(value, 0), truncated };
}

// ---- versions --------------------------------------------------------------------------------

/** `2.1.278 (Claude Code)` -> `2.1.278`; `opencode v2.0.4` -> `2.0.4`. */
export function extractVersion(raw: string | null): string | null {
  if (!raw) return null;
  const line = raw
    .split(/\r?\n/)
    .find((l) => l.trim().length > 0)
    ?.trim();
  if (!line) return null;
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(line);
  return m?.[1] ?? line;
}

// ---- environment -----------------------------------------------------------------------------

export interface ChildEnvInput {
  base: Record<string, string | undefined>;
  agentConfig: AgentConfig | null;
  agent: AgentRef;
  runId: string;
  side: Side;
  workspace: string;
  harnessDir: string | null;
}

export interface ChildEnv {
  env: Record<string, string>;
  addedKeys: string[];
}

/** Variables Arena always sets so a harness can tell it is running inside a battle. */
export const ARENA_ENV_KEYS = ['ARENA_RUN_ID', 'ARENA_SIDE', 'ARENA_WORKSPACE', 'ARENA_BATTLE'] as const;

/**
 * Claude Code refuses to start a nested session while these are set, so a battle launched from
 * inside Claude Code would fail. They are the agent's own markers, never user secrets.
 */
export const UNSET_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] as const;

export function substituteEnvValue(
  value: string,
  ctx: { workspace: string; harnessDir: string | null },
): string {
  return value
    .split('${ARENA_WORKSPACE}')
    .join(ctx.workspace)
    .split('${ARENA_HARNESS_DIR}')
    .join(ctx.harnessDir ?? '');
}

/** Values are never logged; only key names travel into telemetry. */
export function buildChildEnv(input: ChildEnvInput): ChildEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const key of UNSET_ENV_KEYS) delete env[key];

  const added = new Set<string>();
  const subCtx = { workspace: input.workspace, harnessDir: input.harnessDir };
  for (const source of [input.agentConfig?.env, input.agent.env]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      env[key] = substituteEnvValue(value, subCtx);
      added.add(key);
    }
  }

  env.ARENA_RUN_ID = input.runId;
  env.ARENA_SIDE = input.side;
  env.ARENA_WORKSPACE = input.workspace;
  env.ARENA_BATTLE = '1';
  for (const key of ARENA_ENV_KEYS) added.add(key);

  return { env, addedKeys: [...added].sort() };
}

// ---- error classification --------------------------------------------------------------------

export type AdapterErrorCode =
  'provider_limit' | 'auth' | 'not_installed' | 'timeout' | 'interrupted' | 'unknown';

const ERROR_PATTERNS: ReadonlyArray<readonly [AdapterErrorCode, RegExp]> = [
  [
    'provider_limit',
    /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b|purchase more credits|out of credits|credit balance|overloaded/i,
  ],
  [
    'auth',
    /not logged in|please log ?in|log in again|login required|unauthorized|\b401\b|\b403\b|forbidden|invalid api key|missing api key|api key not (?:found|valid)|authenticat|ineligible|no credentials|sign in/i,
  ],
  [
    'not_installed',
    /\benoent\b|command not found|is not recognized as|no such file or directory|not installed/i,
  ],
  ['timeout', /timed out|timeout|etimedout|deadline exceeded/i],
  ['interrupted', /\bsigint\b|\bsigterm\b|interrupted|aborted|cancell?ed/i],
];

/** Maps provider error prose to a stable code. Order matters: a limit reads as a limit, not a timeout. */
export function classifyError(text: string | null | undefined): AdapterErrorCode {
  if (!text) return 'unknown';
  for (const [code, pattern] of ERROR_PATTERNS) {
    if (pattern.test(text)) return code;
  }
  return 'unknown';
}

// ---- harness paths ---------------------------------------------------------------------------

/** Resolve a manifest-relative path against the harness checkout, refusing to escape it. */
export function resolveHarnessPath(relative: string, harnessDir: string | null): string | null {
  if (path.isAbsolute(relative)) return relative;
  if (!harnessDir) return null;
  const root = path.resolve(harnessDir);
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

/**
 * `systemPromptAppend` is either literal text or a `.md`/`.txt` file inside the harness. A path that
 * cannot be read falls back to the literal text so a broken manifest never silently drops it.
 */
export async function resolveSystemPromptAppend(
  value: string,
  harnessDir: string | null,
): Promise<{ text: string; fromFile: string | null }> {
  const candidate = value.trim();
  if (/[\r\n]/.test(value) || !/\.(md|txt)$/i.test(candidate)) return { text: value, fromFile: null };
  const resolved = resolveHarnessPath(candidate, harnessDir);
  if (!resolved) return { text: value, fromFile: null };
  try {
    const text = await readFile(resolved, 'utf8');
    return { text, fromFile: resolved };
  } catch {
    return { text: value, fromFile: null };
  }
}

/** First value following one of `flags` in an argv array. */
export function argValue(args: readonly string[], flags: readonly string[]): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (flags.includes(args[i] as string)) return args[i + 1] as string;
  }
  return null;
}

// ---- usage -----------------------------------------------------------------------------------

/** Sum two usage blocks, keeping fields absent when neither side reported them. */
export function addUsage(into: Usage | null, add: Usage | null): Usage | null {
  if (!add) return into;
  const base = into ?? {};
  const sum = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const merged: Usage = {};
  const inputTokens = sum(base.inputTokens, add.inputTokens);
  if (inputTokens !== undefined) merged.inputTokens = inputTokens;
  const outputTokens = sum(base.outputTokens, add.outputTokens);
  if (outputTokens !== undefined) merged.outputTokens = outputTokens;
  const cacheReadTokens = sum(base.cacheReadTokens, add.cacheReadTokens);
  if (cacheReadTokens !== undefined) merged.cacheReadTokens = cacheReadTokens;
  const cacheWriteTokens = sum(base.cacheWriteTokens, add.cacheWriteTokens);
  if (cacheWriteTokens !== undefined) merged.cacheWriteTokens = cacheWriteTokens;
  const totalTokens = sum(base.totalTokens, add.totalTokens);
  if (totalTokens !== undefined) merged.totalTokens = totalTokens;
  const costUsd = sum(base.costUsd, add.costUsd);
  if (costUsd !== undefined) merged.costUsd = Math.round(costUsd * 1e6) / 1e6;
  return merged;
}

// ---- shared CLI execution --------------------------------------------------------------------

/** Keeps the tail of stderr so a failure can be explained without retaining the whole stream. */
export class StderrTail {
  private readonly lines: string[] = [];

  constructor(private readonly max = 20) {}

  push(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.lines.push(trimmed);
    if (this.lines.length > this.max) this.lines.shift();
  }

  text(): string {
    return this.lines.join('\n');
  }
}

export interface CliRunOptions {
  adapterId: string;
  prepared: PreparedRun;
  ctx: ExecuteContext;
  parser: StreamParser;
  /** model requested on the command line, used when the CLI does not report one */
  fallbackModel?: string | null;
  version?: string | null;
}

/**
 * The execute() body every CLI adapter shares: stream lines through the parser, emit events, then
 * turn the process outcome into an AdapterResult. Status never comes from guesswork: abort, timeout
 * and spawn failure are distinguished by the runner, not inferred from text.
 */
export async function runCliProcess(opts: CliRunOptions): Promise<AdapterResult> {
  const { adapterId, prepared, ctx, parser } = opts;
  const stderr = new StderrTail();
  const log = ctx.logger.child({ adapter: adapterId });

  const run = await ctx.runner.run({
    command: prepared.command,
    args: prepared.args,
    cwd: prepared.cwd,
    env: prepared.env,
    stdin: prepared.stdin,
    signal: ctx.signal,
    timeoutMs: ctx.limits.timeoutMs,
    maxOutputBytes: ctx.limits.maxOutputBytes,
    onStdoutLine: (line) => {
      ctx.onRawLine?.('stdout', line);
      for (const ev of parser.feed(line, 'stdout')) ctx.emit(ev);
    },
    onStderrLine: (line) => {
      ctx.onRawLine?.('stderr', line);
      stderr.push(line);
      for (const ev of parser.feed(line, 'stderr')) ctx.emit(ev);
    },
  });

  const finished = parser.finish();
  for (const ev of finished.events) ctx.emit(ev);
  const parsed = finished.result;

  let status: AdapterRunStatus;
  if (run.aborted) status = 'interrupted';
  else if (run.timedOut) status = 'timed_out';
  else if (run.spawnError) status = 'failed';
  else if (parsed.status === 'failed') status = 'failed';
  else status = run.exitCode === 0 ? 'completed' : 'failed';

  if (status === 'timed_out') {
    ctx.emit({
      type: 'limit.hit',
      payload: { kind: 'timeout', detail: `no result within ${ctx.limits.timeoutMs}ms` },
      confidence: 'derived',
    });
  }
  if (status === 'interrupted') {
    ctx.emit({ type: 'interrupt', payload: { reason: 'user' }, confidence: 'derived' });
  }
  if (run.truncated) {
    ctx.emit({
      type: 'limit.hit',
      payload: { kind: 'max_output', detail: `output exceeded ${ctx.limits.maxOutputBytes} bytes` },
      confidence: 'derived',
    });
  }

  let errorCode = parsed.errorCode ?? null;
  let errorMessage = parsed.errorMessage ?? null;
  if (run.spawnError) {
    errorCode = classifyError(run.spawnError) === 'not_installed' ? 'not_installed' : 'unknown';
    errorMessage = run.spawnError;
  } else if (status === 'timed_out') {
    errorCode = 'timeout';
    errorMessage = errorMessage ?? `run exceeded ${ctx.limits.timeoutMs}ms`;
  } else if (status === 'interrupted') {
    errorCode = 'interrupted';
    errorMessage = errorMessage ?? 'run was aborted';
  } else if (status === 'failed' && !errorCode) {
    const tail = stderr.text();
    errorCode = classifyError(tail || errorMessage);
    errorMessage = errorMessage ?? (tail || `exit code ${String(run.exitCode)}`);
  }

  log.debug('cli run finished', {
    status,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    truncated: run.truncated,
  });

  return {
    status,
    exitCode: run.exitCode,
    finalResponse: parsed.finalResponse ?? null,
    usage: parsed.usage ?? null,
    model: parsed.model ?? opts.fallbackModel ?? null,
    version: parsed.version ?? opts.version ?? null,
    turns: parsed.turns ?? null,
    errorCode,
    errorMessage,
    native: { ...(parsed.native ?? {}), exitSignal: run.signal, outputBytes: run.outputBytes },
  };
}

// ---- logging ---------------------------------------------------------------------------------

export function createNoopLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

/**
 * Structured console logger. Adapters never pass env values or prompt bodies to it, and debug
 * output stays off unless the caller asks for it.
 */
export function createConsoleLogger(options: { level?: 'debug' | 'info' | 'warn' | 'error' } = {}): Logger {
  const order = { debug: 10, info: 20, warn: 30, error: 40 } as const;
  const min = order[options.level ?? 'info'];
  const make = (bindings: Record<string, unknown>): Logger => {
    const emit = (level: keyof typeof order, msg: string, data?: Record<string, unknown>) => {
      if (order[level] < min) return;
      const line = JSON.stringify({ level, msg, ...bindings, ...(data ?? {}) });
      if (level === 'error' || level === 'warn') console.error(line);
      else console.log(line);
    };
    return {
      debug: (msg, data) => emit('debug', msg, data),
      info: (msg, data) => emit('info', msg, data),
      warn: (msg, data) => emit('warn', msg, data),
      error: (msg, data) => emit('error', msg, data),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  };
  return make({});
}
