import type { AdapterEvent, AgentConfig, AgentId, AgentRef, Limits, ResolvedTask, Side, Usage } from '@harness-arena/protocol';

/**
 * The adapter contract. An adapter wraps an OFFICIAL agent CLI process. It never re-implements the
 * provider, never touches credentials, and never fabricates telemetry: capabilities() declares what
 * it can observe, and everything else is reported as unavailable.
 */

export type ObservabilityStatus = 'observed' | 'derived' | 'unavailable';

export interface AdapterCapabilities {
  tokens: ObservabilityStatus;
  cost: ObservabilityStatus;
  model: ObservabilityStatus;
  toolCalls: ObservabilityStatus;
  commands: ObservabilityStatus;
  fileReads: ObservabilityStatus;
  fileChanges: ObservabilityStatus;
  subagents: ObservabilityStatus;
  turns: ObservabilityStatus;
  thinking: ObservabilityStatus;
  contextCompaction: ObservabilityStatus;
  /** can the CLI be told to ignore the user's global configuration? */
  userConfigIsolation: boolean;
  /** the prompt is delivered on stdin (never via argv) */
  stdinPrompt: boolean;
  /** free-text notes shown in the UI, e.g. "cost is a list-price estimate computed by the CLI" */
  notes: string[];
}

export interface Detection {
  id: AgentId;
  installed: boolean;
  /** absolute path of the binary, or null */
  path: string | null;
  version: string | null;
  /** best-effort; 'unknown' when the CLI gives no cheap way to tell */
  auth: 'ok' | 'missing' | 'unknown';
  notes: string[];
}

export interface ValidationResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface PrepareContext {
  runId: string;
  side: Side;
  /** absolute path of the run workspace (a git worktree owned by Arena) */
  workspace: string;
  /** absolute path of the harness checkout; null for vanilla */
  harnessDir: string | null;
  /** manifest.agentConfig[agent.id], already validated; null when absent */
  agentConfig: AgentConfig | null;
  agent: AgentRef;
  /** fake adapter only: fixture name or absolute path of a fixture JSON */
  fixture: string | null;
  task: ResolvedTask;
  limits: Limits;
  /** base environment for the child (Arena strips its own internals first) */
  env: Record<string, string | undefined>;
  logger: Logger;
}

export interface PreparedRun {
  /** absolute binary path or bare name resolvable on PATH */
  command: string;
  /** fixed arguments; MUST NOT contain the task prompt when stdinPrompt is true */
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** prompt text written to stdin, or null when passed another way */
  stdin: string | null;
  /** shown to the user before execution; never includes env values or the prompt body */
  disclosure: {
    command: string;
    args: string[];
    envKeysAdded: string[];
    promptVia: 'stdin' | 'arg' | 'file';
    notes: string[];
  };
  /** true when user-level config was excluded, false when it could not be, null when unknown */
  userConfigIsolated: boolean | null;
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
  /** output stopped being delivered after maxOutputBytes; the process was killed */
  truncated: boolean;
  durationMs: number;
  /** when the binary could not be spawned at all */
  spawnError: string | null;
}

/** Injected so adapter tests can run without a real CLI. The default runner lives in ./process.ts. */
export interface ProcessRunner {
  run(opts: ProcessRunOptions): Promise<ProcessRunResult>;
}

export interface ExecuteContext {
  emit(event: AdapterEvent): void;
  /** aborting MUST kill the whole process tree */
  signal: AbortSignal;
  logger: Logger;
  limits: Limits;
  runner: ProcessRunner;
  /** raw provider lines, for the raw log kept on the local machine */
  onRawLine?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export type AdapterRunStatus = 'completed' | 'failed' | 'timed_out' | 'interrupted';

export interface AdapterResult {
  status: AdapterRunStatus;
  exitCode: number | null;
  finalResponse: string | null;
  /** aggregated over the run; null when the CLI reports nothing */
  usage: Usage | null;
  model: string | null;
  version: string | null;
  turns: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** adapter-specific summary (session ids, native stop reasons); must not contain secrets */
  native: Record<string, unknown>;
}

/** A pure, testable translator from provider output lines to protocol events. */
export interface StreamParser {
  feed(line: string, stream?: 'stdout' | 'stderr'): AdapterEvent[];
  finish(): { events: AdapterEvent[]; result: Partial<AdapterResult> };
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly kind: 'cli' | 'fake';
  /** binary names looked up on PATH, in order */
  readonly binaryNames: readonly string[];
  capabilities(): AdapterCapabilities;
  detect(env?: Record<string, string | undefined>): Promise<Detection>;
  validate(detection: Detection): Promise<ValidationResult>;
  getVersion(): Promise<string | null>;
  prepare(ctx: PrepareContext): Promise<PreparedRun>;
  execute(prepared: PreparedRun, ctx: ExecuteContext): Promise<AdapterResult>;
  cleanup(ctx: { workspace: string; runId: string }): Promise<void>;
  createParser(): StreamParser;
}

export interface AdapterRegistry {
  list(): AgentAdapter[];
  get(id: string): AgentAdapter | undefined;
  register(adapter: AgentAdapter): void;
}
