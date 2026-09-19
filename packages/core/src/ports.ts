import type {
  AdapterEvent,
  AgentConfig,
  EvaluationReport,
  HarnessInspection,
  HarnessManifest,
  HarnessRef,
  HarnessSource,
  ResolvedTask,
  RunMetrics,
  RunStatus,
  Side,
  BattleSpec,
  RunArtifacts,
  Verdict,
  testParserSchema,
} from '@harness-arena/protocol';
import type { Logger, ProcessRunner } from '@harness-arena/adapters';
import type { JudgeRunner } from '@harness-arena/evaluator';
import type { z } from 'zod';

/**
 * Ports the engine depends on. `@harness-arena/harness` and `@harness-arena/evaluator` implement
 * these; the engine only ever sees the structural shape, which keeps the dependency direction
 * one-way and lets tests inject fakes through `RunBattleOptions.deps`.
 */

export type TestParser = z.infer<typeof testParserSchema>;

// ---- harness port -----------------------------------------------------------------------------

export interface ResolvedHarness {
  name: string;
  kind: 'vanilla' | 'github' | 'git' | 'local';
  source: HarnessSource;
  /** absolute path of the harness checkout; null for vanilla */
  dir: string | null;
  commit: string | null;
  manifest: HarnessManifest | null;
  inspection: HarnessInspection;
}

export interface ResolveHarnessOptions {
  home: string;
  agentId: string;
  logger: Logger;
}

export interface ApplyHarnessOptions {
  workspace: string;
  agentId: string;
  /** the user approved the harness's install/prepare commands */
  trusted: boolean;
  runner: ProcessRunner;
  env: Record<string, string>;
  logger: Logger;
  signal?: AbortSignal;
}

export interface ApplyHarnessResult {
  appliedFiles: string[];
  executedCommands: string[];
  /** harness files left alone because the repository already had a file at that path */
  skippedFiles?: string[];
  agentConfig: AgentConfig | null;
}

/** What applying a harness would execute; shown to the user before they trust it. */
export interface HarnessExecution {
  commands: string[];
  files: string[];
}

export type ResolveHarnessFn = (ref: HarnessRef, opts: ResolveHarnessOptions) => Promise<ResolvedHarness>;
export type ApplyHarnessFn = (h: ResolvedHarness, opts: ApplyHarnessOptions) => Promise<ApplyHarnessResult>;
export type DescribeExecutionFn = (h: ResolvedHarness) => HarnessExecution;

// ---- evaluator port ---------------------------------------------------------------------------

export interface TestOutcome {
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  total: number | null;
  durationMs: number;
  parser: string;
  output: string;
  failingTests: string[];
}

export interface RunTestsOptions {
  command: string;
  cwd: string;
  parser: TestParser;
  timeoutMs: number;
  runner: ProcessRunner;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

/**
 * Optional, always labelled subjective. The engine never builds one; it only passes one through to the
 * evaluator, so the type must be the evaluator's own — a structural look-alike declared here would
 * silently stop matching the moment the evaluator changed it.
 */
export type { JudgeRunner };

export interface EvaluationSideInput {
  /** absolute path the evaluator works in: the worktree root, or `repository.subdir` inside it */
  workspace: string;
  startCommit: string | null;
  status: RunStatus;
  metrics: RunMetrics;
  artifacts: RunArtifacts;
  finalResponse: string | null;
  baseline: TestOutcome | null;
  /** the post-run test outcome the engine already measured, so evaluators need not re-run the suite */
  postTests: TestOutcome | null;
}

export interface EvaluationContext {
  spec: BattleSpec;
  task: ResolvedTask;
  sides: Record<Side, EvaluationSideInput>;
  runner: ProcessRunner;
  logger: Logger;
  emit: (side: Side | null, event: AdapterEvent) => void;
  signal?: AbortSignal;
  judge?: JudgeRunner;
}

export type RunTestsFn = (opts: RunTestsOptions) => Promise<TestOutcome>;
export type EvaluateBattleFn = (ctx: EvaluationContext) => Promise<EvaluationReport>;
export type DecideVerdictFn = (
  report: EvaluationReport,
  sides: Record<Side, { status: RunStatus; metrics: RunMetrics }>,
) => Verdict;

// ---- issue port -------------------------------------------------------------------------------

export interface ResolveIssueInput {
  repo: string;
  number: number;
  instructions?: string;
}

export interface ResolveIssueOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export type ResolveIssueFn = (input: ResolveIssueInput, opts: ResolveIssueOptions) => Promise<ResolvedTask>;
