import type {
  AdapterEvent,
  BattleSpec,
  EvaluatorResult,
  ResolvedTask,
  RunArtifacts,
  RunMetrics,
  RunStatus,
  Side,
} from '@harness-arena/protocol';
import { testParserSchema } from '@harness-arena/protocol';
import type { z } from 'zod';

export type TestParser = z.infer<typeof testParserSchema>;
export const TEST_PARSERS = testParserSchema.options;

/**
 * Structural mirrors of the three interfaces this package consumes from `@harness-arena/adapters`
 * (`Logger`, `ProcessRunner` and its options/result). They are declared here, byte-for-byte in shape,
 * because `packages/adapters/src/index.ts` does not export them yet (that package is written in
 * parallel) and tsc cannot import across package roots. TypeScript is structural, so a real
 * `adapters` ProcessRunner/Logger satisfies these without a cast. Replace with
 * `import type { Logger, ProcessRunner } from '@harness-arena/adapters'` once the barrel exports them.
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

/** Counts a parser could extract. `null` means "the tool did not say", never zero. */
export interface ParsedTestOutput {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  total: number | null;
  failingTests: string[];
  /** the parser that actually produced these numbers ('exit-code' when nothing could be parsed) */
  parser: string;
}

export interface TestOutcome {
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  total: number | null;
  durationMs: number;
  parser: string;
  /** combined stdout+stderr, capped at 512 KB (oldest lines dropped first, see runTests) */
  output: string;
  failingTests: string[];
}

/** Everything an evaluator knows about one side of a battle. */
export interface SideContext {
  /** absolute path of the run workspace */
  workspace: string;
  startCommit: string | null;
  status: RunStatus;
  metrics: RunMetrics;
  artifacts: RunArtifacts;
  finalResponse: string | null;
  /** test outcome measured on the untouched workspace, when a baseline ran */
  baseline: TestOutcome | null;
}

export interface EvaluationContext {
  spec: BattleSpec;
  task: ResolvedTask;
  sides: Record<Side, SideContext>;
  runner: ProcessRunner;
  logger: Logger;
  emit: (side: Side | null, event: AdapterEvent) => void;
  signal?: AbortSignal;
  judge?: JudgeRunner;
}

export interface Evaluator {
  id: string;
  kind: 'deterministic' | 'subjective';
  applies(ctx: EvaluationContext): boolean;
  run(ctx: EvaluationContext): Promise<EvaluatorResult[]>;
}

/**
 * Supplied by core/cli: an already-authenticated agent CLI used as a blind judge. This package never
 * spawns a judge itself and never pays for model usage.
 */
export interface JudgeRunner {
  agentId: string;
  model: string | null;
  ask(prompt: string, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<string>;
}

/** A Logger that drops everything. Handy in tests and in non-interactive callers. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
