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
import type { Logger, ProcessRunner } from '@harness-arena/adapters';
import type { z } from 'zod';

export type TestParser = z.infer<typeof testParserSchema>;
export const TEST_PARSERS = testParserSchema.options;

/**
 * The process/logging contract is owned by `@harness-arena/adapters`; this package consumes it rather
 * than mirroring it, so a change to `ProcessRunOptions` (for example `windowsVerbatimArguments`)
 * cannot drift between the two.
 */
export type { Logger, ProcessRunOptions, ProcessRunResult, ProcessRunner } from '@harness-arena/adapters';

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
  /**
   * Post-run test outcome the engine already measured (and already emitted `test.completed` for).
   * When it is present the `repo-tests` evaluator reuses it instead of running the suite a second
   * time; `null` means nobody has run the tests after the agent, so the evaluator runs them itself.
   */
  postTests: TestOutcome | null;
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
