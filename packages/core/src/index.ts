export { ARENA_VERSION } from './version.js';

export { createLogger, createSilentLogger } from './logger.js';
export type { LogLevel, LoggerOptions } from './logger.js';

export {
  collectSecretEnvValues,
  createPassthroughRedactor,
  createRedactor,
  MIN_SECRET_LENGTH,
  REDACTED,
  withRedactedAgentEnv,
  withRedactedManifestEnv,
} from './redact.js';
export type { Redactor, RedactorOptions } from './redact.js';

export { createStateStore, defaultHome, sourceKey, LOCK_STALE_MS } from './store.js';
export type { ArenaConfig, BattleLock, BattlePaths, StateStore } from './store.js';

export {
  ARENA_COMMITTER,
  createWorktree,
  diffStats,
  ensureMirror,
  gitVersion,
  initEmptyRepo,
  isDirty,
  isGitRepo,
  isLocalSource,
  MAX_DIFF_BYTES,
  removeWorktree,
  resolveCommit,
  resolveRemoteHead,
  toGitPath,
} from './git.js';
export type { DiffFile, DiffStats, GitOptions, GitRunResult } from './git.js';

export { createEventBus } from './events.js';
export type { EventBus, EventBusOptions } from './events.js';

export { collectEnvironment } from './environment.js';
export type { CollectEnvironmentOptions } from './environment.js';

export { aggregateRunMetrics } from './metrics.js';
export type { AggregateMetricsInput } from './metrics.js';

export { computeInsights, humanDuration, humanRatio } from './insights.js';

export { buildReportBundle, escapeHtml, renderReportHtml, stripAnsi } from './report/html.js';

export { createUploader, sanitizeRecordForUpload } from './upload.js';
export type { ArtifactKind, CreatedBattle, Uploader, UploaderOptions, UploadStats } from './upload.js';

export { runBattle } from './engine.js';
export type { RunBattleDeps, RunBattleOptions } from './engine.js';

export * from './benchmarks.js';

export { createDemoSpec, DEMO_PROMPT, runDemoBattle, ensureDemoRepository } from './demo.js';

export { loadAdapters, loadEvaluator, loadHarness } from './deps.js';
export type { AdaptersModule, EvaluatorModule, HarnessModule } from './deps.js';

export type {
  ApplyHarnessFn,
  ApplyHarnessOptions,
  ApplyHarnessResult,
  DecideVerdictFn,
  DescribeExecutionFn,
  EvaluateBattleFn,
  EvaluationContext,
  EvaluationSideInput,
  HarnessExecution,
  JudgeRunner,
  ResolveHarnessFn,
  ResolveHarnessOptions,
  ResolveIssueFn,
  ResolveIssueInput,
  ResolveIssueOptions,
  ResolvedHarness,
  RunTestsFn,
  RunTestsOptions,
  TestOutcome,
  TestParser,
} from './ports.js';
