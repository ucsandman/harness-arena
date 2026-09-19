export type * from './types.js';

export { LineSplitter, defaultProcessRunner, killProcessTree, runProcess } from './process.js';

export { VERSION_TIMEOUT_MS, detectAgents, findBinary, getSemverOf, getVersionOf } from './detect.js';
export type { VersionOptions } from './detect.js';

export { builtinAdapters, createRegistry } from './registry.js';

export {
  ARENA_ENV_KEYS,
  StderrTail,
  UNSET_ENV_KEYS,
  addUsage,
  argValue,
  asRecord,
  buildChildEnv,
  classifyError,
  createConsoleLogger,
  createNoopLogger,
  extractVersion,
  parseJsonLine,
  readArray,
  readBoolean,
  readNumber,
  readRecord,
  readString,
  resolveHarnessPath,
  resolveSystemPromptAppend,
  runCliProcess,
  substituteEnvValue,
  textOf,
  truncateText,
  truncateValue,
} from './shared.js';
export type { AdapterErrorCode, ChildEnv, ChildEnvInput, CliRunOptions, JsonParse } from './shared.js';

export { ClaudeCodeAdapter } from './claude-code/adapter.js';
export { ClaudeCodeParser } from './claude-code/parser.js';
export { CodexAdapter } from './codex/adapter.js';
export { CodexParser } from './codex/parser.js';
export { GeminiCliAdapter } from './gemini-cli/adapter.js';
export { GeminiCliParser } from './gemini-cli/parser.js';
export { OpenCodeAdapter } from './opencode/adapter.js';
export { OpenCodeParser } from './opencode/parser.js';

export { DEFAULT_FAKE_FIXTURE, FAKE_AGENT_VERSION, FAKE_FIXTURE_ENV, FakeAdapter } from './fake/adapter.js';
export type { FakeAdapterOptions } from './fake/adapter.js';
export {
  FAKE_FIXTURE_DIR,
  fakeEventSchema,
  fakeFsOpSchema,
  fakeResultSchema,
  fakeScriptSchema,
  fakeStepSchema,
  fakeUsageSchema,
  listFakeFixtures,
  loadFakeFixture,
  resolveFakeFixturePath,
  FAKE_DEMO_PROJECT_DIR,
} from './fake/fixtures.js';
export type { FakeFsOp, FakeScript, FakeStep } from './fake/fixtures.js';
