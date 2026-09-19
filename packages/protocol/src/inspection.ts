import { z } from 'zod';
import { harnessManifestSchema } from './manifest.js';

/** The report produced by inspecting a harness repository (GitHub URL or local path) without executing it. */

export const harnessSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vanilla'), agent: z.string().optional() }),
  z.object({
    kind: z.literal('github'),
    url: z.string(),
    owner: z.string(),
    repo: z.string(),
    ref: z.string().nullable(),
    /** subdirectory when the URL points at a tree path */
    path: z.string().nullable(),
  }),
  z.object({ kind: z.literal('git'), url: z.string(), ref: z.string().nullable() }),
  z.object({ kind: z.literal('local'), path: z.string() }),
]);
export type HarnessSource = z.infer<typeof harnessSourceSchema>;

export const HARNESS_FEATURE_IDS = [
  'claude_md',
  'claude_settings',
  'claude_hooks',
  'claude_skills',
  'claude_subagents',
  'claude_commands',
  'claude_plugins',
  'mcp',
  'agents_md',
  'codex_config',
  'gemini_md',
  'gemini_config',
  'opencode_config',
  'opencode_agents',
  'cursor_rules',
  'arena_manifest',
] as const;
export const harnessFeatureIdSchema = z.enum(HARNESS_FEATURE_IDS);
export type HarnessFeatureId = z.infer<typeof harnessFeatureIdSchema>;

export const HARNESS_FEATURE_LABELS: Record<HarnessFeatureId, string> = {
  claude_md: 'CLAUDE.md',
  claude_settings: 'Claude settings',
  claude_hooks: 'Hooks',
  claude_skills: 'Skills',
  claude_subagents: 'Subagents',
  claude_commands: 'Commands',
  claude_plugins: 'Plugins',
  mcp: 'MCP',
  agents_md: 'AGENTS.md',
  codex_config: 'Codex config',
  gemini_md: 'GEMINI.md',
  gemini_config: 'Gemini config',
  opencode_config: 'OpenCode config',
  opencode_agents: 'OpenCode agents',
  cursor_rules: 'Cursor rules',
  arena_manifest: 'arena.yaml',
};

export const harnessFeatureSchema = z.object({
  id: harnessFeatureIdSchema,
  label: z.string(),
  detected: z.boolean(),
  paths: z.array(z.string()),
  count: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});
export type HarnessFeature = z.infer<typeof harnessFeatureSchema>;

export const inspectionFrameworkSchema = z.enum(['claude-code', 'codex', 'gemini-cli', 'opencode', 'multi', 'unknown']);

export const harnessInspectionSchema = z.object({
  source: harnessSourceSchema,
  /** commit the inspection was taken at, when known */
  commit: z.string().nullable(),
  framework: inspectionFrameworkSchema,
  /** agents this harness can run under (from manifest or detected files) */
  agents: z.array(z.string()),
  manifest: z.object({
    found: z.boolean(),
    path: z.string().nullable(),
    valid: z.boolean(),
    errors: z.array(z.string()),
    manifest: harnessManifestSchema.nullable(),
  }),
  features: z.array(harnessFeatureSchema),
  install: z.object({
    packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv', 'poetry', 'cargo', 'go', 'none', 'unknown']),
    runtime: z.enum(['node', 'python', 'rust', 'go', 'shell', 'none', 'unknown']),
    /** commands Arena would run (from the manifest); shown to the user before trust */
    commands: z.array(z.string()),
  }),
  /** files that would be applied to a workspace (manifest `files` or auto-detected) */
  applyFiles: z.array(z.string()),
  compatibility: z.object({
    status: z.enum(['ready', 'partial', 'unknown', 'incompatible']),
    reasons: z.array(z.string()),
  }),
  fileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  inspectedAt: z.string(),
});
export type HarnessInspection = z.infer<typeof harnessInspectionSchema>;
