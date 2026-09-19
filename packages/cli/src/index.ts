/**
 * `harness-arena` — the arena CLI. Thin over @harness-arena/core: every battle goes through
 * runBattle, every detection through @harness-arena/adapters, every inspection through
 * @harness-arena/harness.
 */

export { createProgram } from './program.js';

export { resolveDeps, createClackPrompter } from './deps.js';
export type { CliDeps, Prompter, PromptOption } from './deps.js';

export { CliError, CancelledError, EXIT, errorMessage } from './errors.js';

export {
  createUi,
  createUiLogger,
  createStatusView,
  describeEvent,
  formatMetric,
  metricsTable,
  shortDate,
  supportsUnicode,
  TERMINAL_METRICS,
} from './ui.js';
export type { Palette, StatusView, Symbols, Ui } from './ui.js';

export {
  DEFAULT_SERVER_URL,
  clearLogin,
  getToken,
  readConfig,
  recentHarnesses,
  rememberHarnesses,
  resolveHome,
  resolveServerUrl,
  saveLogin,
} from './config.js';
export type { StoredLogin } from './config.js';

export {
  parseDuration,
  parseExclusions,
  parseIssueRef,
  parsePositiveInt,
  parsePositiveNumber,
  parseSpec,
  parseUploadLevel,
  parseVisibility,
  readSpecFile,
  readTaskFile,
  repoFromSource,
} from './spec.js';
export type { IssueRef, UploadLevel } from './spec.js';

export {
  battleJson,
  createLazyUploader,
  executeBattle,
  finishBattle,
  printBattleOutcome,
  verdictLine,
} from './runner.js';
export type { BattleOutcome, ExecuteBattleOptions } from './runner.js';

export { githubToken, resolveHarnessForCli } from './harness.js';
export type { ResolveForCliOptions } from './harness.js';

// ---- command handlers -------------------------------------------------------------------------

export { battleCommand, buildBattleSpec, requireInstalledAgent } from './commands/battle.js';
export type { BattleFlags, BuildSpecInput } from './commands/battle.js';
export { runCommand, fetchPendingSpec } from './commands/run.js';
export type { RunFlags } from './commands/run.js';
export { demoCommand, rewriteHome } from './commands/demo.js';
export type { DemoFlags } from './commands/demo.js';
export { openCommand, replayCommand } from './commands/replay.js';
export type { ReplayFlags } from './commands/replay.js';
export { statusCommand, resolveBattleId } from './commands/status.js';
export type { StatusFlags } from './commands/status.js';
export { listCommand } from './commands/list.js';
export type { ListFlags } from './commands/list.js';
export { agentsCommand, agentMark, capabilitySummary, collectAgentRows } from './commands/agents.js';
export type { AgentRow, AgentsFlags } from './commands/agents.js';
export {
  harnessInspectCommand,
  harnessListCommand,
  printInspection,
  readCachedHarnesses,
} from './commands/harnesses.js';
export type { CachedHarness, InspectFlags } from './commands/harnesses.js';
export { loginCommand, logoutCommand, whoamiCommand, deviceName } from './commands/login.js';
export type { LoginFlags } from './commands/login.js';
export { doctorCommand, directorySize, humanBytes } from './commands/doctor.js';
export type { DoctorFlags, OrphanWorkspace, StaleLock } from './commands/doctor.js';
export {
  regressionCommand,
  headlineLine,
  listSpecFiles,
  regressionMarkdown,
  rowFromRecord,
  summarizeRegression,
} from './commands/regression.js';
export type {
  RegressionFlags,
  RegressionRow,
  RegressionSummary,
  SideSummary,
} from './commands/regression.js';
export { cleanCommand } from './commands/clean.js';
export type { CleanCandidate, CleanFlags } from './commands/clean.js';
export { welcomeCommand, inspectCwd } from './commands/welcome.js';
export type { WelcomeFlags } from './commands/welcome.js';
