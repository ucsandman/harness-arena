export {
  cloneUrl,
  harnessDisplayName,
  HarnessSourceError,
  normalizeSourceKey,
  parseGitHubUrl,
  parseHarnessSource,
  sourceCacheKey,
  type GitHubUrlParts,
} from './source.js';

export {
  createGitHubFileSource,
  createLocalFileSource,
  DEFAULT_IGNORE,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  GitHubSourceError,
  resolveInside,
  toPosix,
  type FetchImpl,
  type FileSource,
  type GitHubErrorKind,
  type GitHubFileSource,
  type GitHubFileSourceOptions,
  type ListResult,
  type LocalFileSource,
  type LocalFileSourceOptions,
} from './file-source.js';

export {
  findManifest,
  loadManifestFromDir,
  MANIFEST_MAX_BYTES,
  parseManifestYaml,
  type FoundManifest,
  type ManifestValidation,
} from './manifest.js';

export { emptyFeatures, inspectHarness, vanillaInspection, type InspectOptions } from './inspect.js';

export {
  createExecaGitRunner,
  HarnessResolveError,
  resolveHarness,
  type HarnessResolveErrorCode,
  type ResolvedHarness,
  type ResolveOptions,
} from './resolve.js';

export {
  applyHarness,
  describeExecution,
  HarnessApplyError,
  HarnessTrustRequiredError,
  plannedCommands,
  resolveAgentConfig,
  type ApplyOptions,
  type ApplyResult,
  type HarnessApplyErrorCode,
  type PlannedCommand,
} from './apply.js';

export {
  nullLogger,
  type GitRunner,
  type Logger,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult,
} from './types.js';
