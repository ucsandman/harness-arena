import { z } from 'zod';
import { battleIdSchema, runIdSchema } from './ids.js';
import { battleStatusSchema, runStatusSchema, sideSchema } from './events.js';
import { runMetricsSchema } from './metrics.js';
import { evaluationReportSchema, verdictSchema, insightSchema } from './evaluation.js';
import { environmentInfoSchema } from './environment.js';
import { harnessManifestSchema } from './manifest.js';

export const BATTLE_SPEC_VERSION = 1 as const;

export const KNOWN_AGENT_IDS = ['claude-code', 'codex', 'gemini-cli', 'opencode', 'fake'] as const;
export const agentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,40}$/, 'agent id must be lowercase kebab-case');
export type AgentId = z.infer<typeof agentIdSchema>;

export const executionModeSchema = z.enum(['local', 'local-byok', 'cloud']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const visibilitySchema = z.enum(['private', 'unlisted', 'public']);
export type Visibility = z.infer<typeof visibilitySchema>;

// ---- task -------------------------------------------------------------------------------------

export const taskSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('prompt'),
    title: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(50_000),
  }),
  z.object({
    kind: z.literal('issue'),
    /** "owner/name" */
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    number: z.number().int().positive(),
    /** Optional extra instructions appended after the issue body. */
    instructions: z.string().max(10_000).optional(),
  }),
]);
export type TaskSpec = z.infer<typeof taskSpecSchema>;

/** A task after resolution: always has a prompt the agent receives verbatim. */
export const resolvedTaskSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('prompt') }),
    z.object({ kind: z.literal('issue'), repo: z.string(), number: z.number().int(), url: z.string() }),
    z.object({ kind: z.literal('demo') }),
  ]),
});
export type ResolvedTask = z.infer<typeof resolvedTaskSchema>;

// ---- repository -------------------------------------------------------------------------------

export const repositorySpecSchema = z.object({
  /** GitHub URL, git URL, local path, or the literal "empty" for greenfield tasks. */
  source: z.string().min(1),
  /** branch, tag, or commit; defaults to the source's HEAD */
  ref: z.string().optional(),
  /** resolved exact commit; filled in by the engine */
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  /** run the agent in a subdirectory of the repository */
  subdir: z.string().optional(),
  submodules: z.boolean().default(false),
});
export type RepositorySpec = z.infer<typeof repositorySpecSchema>;

// ---- competitors ------------------------------------------------------------------------------

export const agentRefSchema = z.object({
  id: agentIdSchema,
  /** provider model alias or full name; passed to the CLI as-is */
  model: z.string().max(100).optional(),
  /** extra CLI arguments appended verbatim (user's own machine; documented, never shell-interpolated) */
  args: z.array(z.string().max(500)).max(50).optional(),
  /** extra environment variables for the agent process; values are redacted from telemetry */
  env: z.record(z.string(), z.string()).optional(),
});
export type AgentRef = z.infer<typeof agentRefSchema>;

export const harnessRefSchema = z.object({
  /** "vanilla" (agent defaults, no harness files), a GitHub/git URL, or a local path */
  source: z.string().min(1),
  ref: z.string().optional(),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  /** path to arena.yaml relative to the harness root (default: arena.yaml) */
  manifestPath: z.string().optional(),
  /** user has approved install/prepare commands declared by the harness */
  trusted: z.boolean().default(false),
});
export type HarnessRef = z.infer<typeof harnessRefSchema>;

export const competitorSpecSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  agent: agentRefSchema,
  harness: harnessRefSchema,
  /** fake adapter only: which deterministic fixture to replay */
  fixture: z.string().optional(),
});
export type CompetitorSpec = z.infer<typeof competitorSpecSchema>;

// ---- limits / evaluation / privacy ------------------------------------------------------------

export const limitsSchema = z.object({
  timeoutMs: z.number().int().positive().max(24 * 3600_000).default(20 * 60_000),
  maxTurns: z.number().int().positive().max(10_000).optional(),
  maxBudgetUsd: z.number().positive().max(10_000).optional(),
  /** cap on captured stdout+stderr bytes per run */
  maxOutputBytes: z.number().int().positive().default(50 * 1024 * 1024),
  /** seconds of no output before the run is considered stalled and interrupted; 0 disables */
  stallTimeoutMs: z.number().int().nonnegative().default(0),
});
export type Limits = z.infer<typeof limitsSchema>;

export const assertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file-exists'), path: z.string(), label: z.string().optional() }),
  z.object({ type: z.literal('file-missing'), path: z.string(), label: z.string().optional() }),
  z.object({
    type: z.literal('file-contains'),
    path: z.string(),
    pattern: z.string(),
    flags: z.string().regex(/^[gimsuy]*$/).optional(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal('file-not-contains'),
    path: z.string(),
    pattern: z.string(),
    flags: z.string().regex(/^[gimsuy]*$/).optional(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal('command'),
    command: z.string(),
    expectExitCode: z.number().int().default(0),
    timeoutMs: z.number().int().positive().default(300_000),
    label: z.string().optional(),
  }),
  z.object({ type: z.literal('diff-touches'), paths: z.array(z.string()).min(1), label: z.string().optional() }),
  z.object({
    type: z.literal('diff-not-touches'),
    paths: z.array(z.string()).min(1),
    label: z.string().optional(),
  }),
  z.object({ type: z.literal('max-files-changed'), max: z.number().int().nonnegative(), label: z.string().optional() }),
]);
export type Assertion = z.infer<typeof assertionSchema>;

export const testParserSchema = z.enum(['auto', 'vitest', 'jest', 'pytest', 'go', 'cargo', 'tap', 'exit-code']);

export const evaluationSpecSchema = z.object({
  tests: z
    .object({
      command: z.string().min(1),
      /** run before the agent so pre-existing failures are not counted as regressions */
      baseline: z.boolean().default(true),
      parser: testParserSchema.default('auto'),
      timeoutMs: z.number().int().positive().default(600_000),
    })
    .optional(),
  build: z.array(z.string()).max(10).optional(),
  lint: z.array(z.string()).max(10).optional(),
  typecheck: z.array(z.string()).max(10).optional(),
  assertions: z.array(assertionSchema).max(100).default([]),
  judge: z
    .object({
      enabled: z.boolean().default(false),
      agent: agentRefSchema.optional(),
      rubric: z.string().max(10_000).optional(),
    })
    .prefault({}),
});
export type EvaluationSpec = z.infer<typeof evaluationSpecSchema>;

export const privacyExclusionSchema = z.enum([
  'file_contents',
  'prompts',
  'model_outputs',
  'diffs',
  'command_output',
  'paths',
]);
export type PrivacyExclusion = z.infer<typeof privacyExclusionSchema>;

export const privacySettingsSchema = z.object({
  /**
   * none:    nothing leaves the machine
   * metrics: record + metrics + verdict, no events/artifacts
   * events:  metrics + events (subject to exclusions)
   * full:    events + artifacts (diff, final response), subject to exclusions
   */
  upload: z.enum(['none', 'metrics', 'events', 'full']).default('none'),
  exclude: z.array(privacyExclusionSchema).default([]),
  /** run the secret redactor over every event and artifact (always on for uploads) */
  redact: z.boolean().default(true),
});
export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

// ---- spec -------------------------------------------------------------------------------------

export const battleSpecSchema = z.object({
  version: z.literal(BATTLE_SPEC_VERSION),
  title: z.string().min(1).max(200).optional(),
  task: taskSpecSchema,
  repository: repositorySpecSchema,
  competitors: z.object({ a: competitorSpecSchema, b: competitorSpecSchema }),
  limits: limitsSchema.prefault({}),
  evaluation: evaluationSpecSchema.prefault({}),
  privacy: privacySettingsSchema.prefault({}),
  mode: executionModeSchema.default('local'),
  visibility: visibilitySchema.default('private'),
  /** run both sides concurrently instead of sequentially (less fair on shared CPU) */
  parallel: z.boolean().default(false),
  tags: z.array(z.string().max(40)).max(20).default([]),
  /** category hint for ratings (debugging, refactoring, greenfield, ...) */
  category: z.string().max(40).optional(),
});
export type BattleSpec = z.infer<typeof battleSpecSchema>;
export type BattleSpecInput = z.input<typeof battleSpecSchema>;

// ---- record -----------------------------------------------------------------------------------

export const harnessSummarySchema = z.object({
  name: z.string(),
  source: z.string(),
  kind: z.enum(['vanilla', 'github', 'git', 'local']),
  commit: z.string().nullable(),
  manifest: harnessManifestSchema.nullable(),
  /** workspace-relative paths that were applied */
  appliedFiles: z.array(z.string()),
  /** commands that were executed on the user's behalf (install/prepare) */
  executedCommands: z.array(z.string()),
});
export type HarnessSummary = z.infer<typeof harnessSummarySchema>;

export const runArtifactsSchema = z.object({
  /** unified diff of the workspace vs the start commit; absent when privacy excludes diffs */
  diff: z.string().nullable().optional(),
  diffBytes: z.number().int().nonnegative().optional(),
  finalResponse: z.string().nullable().optional(),
  /** path of the raw provider log on the machine that ran the battle (never uploaded) */
  rawLogPath: z.string().optional(),
  changedFiles: z
    .array(
      z.object({
        path: z.string(),
        kind: z.enum(['create', 'modify', 'delete', 'rename']),
        linesAdded: z.number().int().nonnegative(),
        linesRemoved: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});
export type RunArtifacts = z.infer<typeof runArtifactsSchema>;

export const runRecordSchema = z.object({
  id: runIdSchema,
  side: sideSchema,
  label: z.string(),
  status: runStatusSchema,
  agent: z.object({
    id: agentIdSchema,
    version: z.string().nullable(),
    model: z.string().nullable(),
    /** telemetry the adapter can observe for this agent */
    capabilities: z.record(z.string(), z.enum(['observed', 'derived', 'unavailable'])),
  }),
  harness: harnessSummarySchema,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  metrics: runMetricsSchema,
  artifacts: runArtifactsSchema,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  eventCount: z.number().int().nonnegative(),
  /** what was actually executed, for disclosure; args never contain the prompt */
  invocation: z
    .object({ command: z.string(), args: z.array(z.string()), envKeys: z.array(z.string()) })
    .nullable(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const verificationSchema = z.object({
  /** local = self-reported by the user's machine; cloud = executed by Arena in controlled sandboxes */
  kind: z.enum(['local', 'cloud']),
  /** eligible for the verified ratings pool */
  eligible: z.boolean(),
  sandbox: z.string().nullable(),
});

export const battleRecordSchema = z.object({
  id: battleIdSchema,
  protocolVersion: z.literal(1),
  arenaVersion: z.string(),
  status: battleStatusSchema,
  spec: battleSpecSchema,
  task: resolvedTaskSchema,
  repository: z.object({
    source: z.string(),
    kind: z.enum(['github', 'git', 'local', 'empty']),
    commit: z.string().nullable(),
    ref: z.string().nullable(),
    dirty: z.boolean().nullable(),
  }),
  environment: environmentInfoSchema,
  runs: z.object({ a: runRecordSchema, b: runRecordSchema }),
  evaluation: evaluationReportSchema.nullable(),
  verdict: verdictSchema.nullable(),
  insights: z.array(insightSchema).default([]),
  verification: verificationSchema,
  /** deterministic demo data; never mixed with real results */
  demo: z.boolean().default(false),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type BattleRecord = z.infer<typeof battleRecordSchema>;

/** Everything a self-contained local report needs. Embedded as JSON in report.html. */
export const reportBundleSchema = z.object({
  record: battleRecordSchema,
  events: z.array(z.unknown()),
  generatedAt: z.string(),
  arenaVersion: z.string(),
});
export type ReportBundle = z.infer<typeof reportBundleSchema>;
