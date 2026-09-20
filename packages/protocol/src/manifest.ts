import { z } from 'zod';
import { agentIdSchema } from './agents.js';

/**
 * arena.yaml — the Harness Adapter Protocol, version 1.
 *
 * A repository declares how Arena should install it, which files to lay into a battle workspace,
 * and how to configure each supported agent. Everything is optional except `arena: 1` and `name`;
 * a repository without arena.yaml is auto-detected (see packages/harness inspect()).
 *
 * Commands in `install`, `prepare`, and `cleanup` run on the user's machine only after the user has
 * trusted the harness. The CLI prints them verbatim before asking.
 */
export const MANIFEST_VERSION = 1 as const;
export const MANIFEST_FILENAMES = ['arena.yaml', 'arena.yml', '.arena.yaml', '.arena/arena.yaml'] as const;

const commandSchema = z.object({
  /** executed via the platform shell in the harness (install) or workspace (prepare/cleanup) directory */
  command: z.string().min(1).max(2000),
  timeoutMs: z.number().int().positive().max(3600_000).default(300_000),
  /** platform gate: run only on these platforms; omitted = all */
  platforms: z.array(z.enum(['win32', 'darwin', 'linux'])).optional(),
});
export type ManifestCommand = z.infer<typeof commandSchema>;

/** Per-agent configuration applied when this harness runs under that agent. */
export const agentConfigSchema = z
  .object({
    /** extra CLI arguments (verbatim; never shell-interpolated) */
    args: z.array(z.string().max(500)).max(50).optional(),
    /** extra environment variables; values may reference ${ARENA_HARNESS_DIR} and ${ARENA_WORKSPACE} */
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000)).optional(),
    /** Claude Code: path (relative to harness root) to a settings JSON passed via --settings */
    settings: z.string().optional(),
    /** Claude Code: path to an MCP config JSON passed via --mcp-config */
    mcpConfig: z.string().optional(),
    /** text or path (relative to harness root, must end in .md/.txt) appended to the system prompt where the CLI supports it */
    systemPromptAppend: z.string().max(20_000).optional(),
    /** model override when the battle does not specify one */
    model: z.string().max(100).optional(),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const harnessManifestSchema = z
  .object({
    arena: z.literal(MANIFEST_VERSION),
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'name must be lowercase; letters, digits, dot, dash, underscore'),
    version: z.string().max(40).optional(),
    description: z.string().max(500).optional(),
    homepage: z.url().optional(),
    /** agent ids this harness supports; empty/omitted = any */
    agents: z.array(agentIdSchema).max(20).optional(),
    /**
     * Files and directories (relative to the harness root) copied into the workspace root.
     * Omitted = auto-detect (CLAUDE.md, .claude/, AGENTS.md, .codex/, GEMINI.md, .gemini/, opencode.json, .opencode/, .mcp.json).
     * Paths may not contain `..`, be absolute, or resolve through symlinks.
     */
    files: z.array(z.string().min(1).max(500)).max(200).optional(),
    /** where inside the workspace to place `files`; default "." */
    target: z.string().max(200).optional(),
    install: commandSchema.optional(),
    prepare: commandSchema.optional(),
    cleanup: commandSchema.optional(),
    agentConfig: z.record(agentIdSchema, agentConfigSchema).optional(),
    capabilities: z
      .object({
        subagents: z.boolean().optional(),
        mcp: z.boolean().optional(),
        hooks: z.boolean().optional(),
        skills: z.boolean().optional(),
        commands: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /**
     * Declared ancestry. Arena records these as `manifest` evidence and never infers a relationship
     * on its own; GitHub fork metadata is recorded separately as `github_fork` evidence.
     */
    lineage: z
      .object({
        forkedFrom: z.url().optional(),
        derivedFrom: z.array(z.url()).max(10).optional(),
        basedOn: z.array(z.url()).max(10).optional(),
      })
      .strict()
      .optional(),
    /** Reusable parts of this harness, so ablations and the component catalogue can name them. */
    components: z
      .array(
        z.object({
          kind: z.enum(['instructions', 'skill', 'hook', 'mcp', 'subagent', 'prompt', 'settings', 'memory']),
          name: z.string().min(1).max(120),
          path: z.string().max(500).optional(),
          description: z.string().max(500).optional(),
          /** where the component came from, when it is not original to this harness */
          source: z.url().optional(),
        }),
      )
      .max(100)
      .optional(),
    /** free-form, for harness authors; ignored by Arena */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type HarnessManifest = z.infer<typeof harnessManifestSchema>;

/** Files auto-detected when a manifest omits `files`. Order matters for display only. */
export const AUTO_DETECT_FILES: ReadonlyArray<{ path: string; agent: string; feature: string }> = [
  { path: 'CLAUDE.md', agent: 'claude-code', feature: 'claude_md' },
  { path: '.claude', agent: 'claude-code', feature: 'claude_dir' },
  { path: '.mcp.json', agent: 'claude-code', feature: 'mcp' },
  { path: 'AGENTS.md', agent: 'codex', feature: 'agents_md' },
  { path: '.codex', agent: 'codex', feature: 'codex_dir' },
  { path: 'GEMINI.md', agent: 'gemini-cli', feature: 'gemini_md' },
  { path: '.gemini', agent: 'gemini-cli', feature: 'gemini_dir' },
  { path: 'opencode.json', agent: 'opencode', feature: 'opencode_config' },
  { path: 'opencode.jsonc', agent: 'opencode', feature: 'opencode_config' },
  { path: '.opencode', agent: 'opencode', feature: 'opencode_dir' },
];

export function validateManifest(
  input: unknown,
): { ok: true; manifest: HarnessManifest } | { ok: false; errors: string[] } {
  const r = harnessManifestSchema.safeParse(input);
  if (r.success) return { ok: true, manifest: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
