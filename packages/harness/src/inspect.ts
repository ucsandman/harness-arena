import {
  AUTO_DETECT_FILES,
  HARNESS_FEATURE_IDS,
  HARNESS_FEATURE_LABELS,
  MANIFEST_FILENAMES,
  type HarnessFeature,
  type HarnessFeatureId,
  type HarnessInspection,
  type HarnessSource,
} from '@harness-arena/protocol';
import type { FileSource } from './file-source.js';
import { findManifest } from './manifest.js';

/**
 * Inspect a harness repository without executing any of it: a file listing plus a handful of small
 * reads. The CLI runs this over a local checkout, the web app over the GitHub REST API.
 */

export interface InspectOptions {
  commit?: string | null;
  now?: () => Date;
  /** explicit manifest path (HarnessRef.manifestPath), tried before the standard filenames */
  manifestPath?: string | null;
}

type InspectionFramework = HarnessInspection['framework'];
type AgentFramework = Exclude<InspectionFramework, 'multi' | 'unknown'>;
type PackageManager = HarnessInspection['install']['packageManager'];
type Runtime = HarnessInspection['install']['runtime'];

const FEATURE_AGENT: Partial<Record<HarnessFeatureId, AgentFramework>> = {
  claude_md: 'claude-code',
  claude_settings: 'claude-code',
  claude_hooks: 'claude-code',
  claude_skills: 'claude-code',
  claude_subagents: 'claude-code',
  claude_commands: 'claude-code',
  claude_plugins: 'claude-code',
  agents_md: 'codex',
  codex_config: 'codex',
  gemini_md: 'gemini-cli',
  gemini_config: 'gemini-cli',
  opencode_config: 'opencode',
  opencode_agents: 'opencode',
};

const CLAUDE_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

const LOCKFILES: ReadonlyArray<{ file: string; packageManager: PackageManager; runtime: Runtime }> = [
  { file: 'pnpm-lock.yaml', packageManager: 'pnpm', runtime: 'node' },
  { file: 'yarn.lock', packageManager: 'yarn', runtime: 'node' },
  { file: 'bun.lockb', packageManager: 'bun', runtime: 'node' },
  { file: 'package-lock.json', packageManager: 'npm', runtime: 'node' },
  { file: 'uv.lock', packageManager: 'uv', runtime: 'python' },
  { file: 'poetry.lock', packageManager: 'poetry', runtime: 'python' },
  { file: 'requirements.txt', packageManager: 'pip', runtime: 'python' },
  { file: 'Cargo.toml', packageManager: 'cargo', runtime: 'rust' },
  { file: 'go.mod', packageManager: 'go', runtime: 'go' },
];

interface FileIndex {
  files: string[];
  lower: string[];
  byLower: Map<string, string>;
  truncated: boolean;
}

function buildIndex(files: string[], truncated: boolean): FileIndex {
  const byLower = new Map<string, string>();
  const lower: string[] = [];
  for (const f of files) {
    const l = f.toLowerCase();
    lower.push(l);
    if (!byLower.has(l)) byLower.set(l, f);
  }
  return { files, lower, byLower, truncated };
}

/** Actual path of a file, matched case-insensitively so Windows and Linux agree. */
function filePath(ix: FileIndex, candidate: string): string | null {
  return ix.byLower.get(candidate.toLowerCase()) ?? null;
}

function underDir(ix: FileIndex, dir: string): string[] {
  const prefix = `${dir.toLowerCase().replace(/\/+$/, '')}/`;
  const out: string[] = [];
  for (let i = 0; i < ix.files.length; i++) {
    if ((ix.lower[i] as string).startsWith(prefix)) out.push(ix.files[i] as string);
  }
  return out;
}

function matching(ix: FileIndex, re: RegExp): string[] {
  return ix.files.filter((f) => re.test(f));
}

function pathExists(ix: FileIndex, candidate: string): boolean {
  return filePath(ix, candidate) !== null || underDir(ix, candidate).length > 0;
}

function firstExisting(ix: FileIndex, candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const p = filePath(ix, c);
    if (p !== null) out.push(p);
  }
  return out;
}

/** Does a JSON (or JSONC) config declare one of these top-level keys? */
async function hasJsonKey(files: FileSource, filePathToRead: string, keys: string[]): Promise<boolean> {
  const raw = await files.read(filePathToRead, 256 * 1024);
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      return keys.some((k) => record[k] !== undefined && record[k] !== null);
    }
    return false;
  } catch {
    // JSONC (comments/trailing commas) or malformed: fall back to a textual key probe
    return keys.some((k) => new RegExp(`"${k}"\\s*:`).test(raw));
  }
}

interface Detected {
  paths: string[];
  count?: number;
  note?: string;
}

export function emptyFeatures(): HarnessFeature[] {
  return HARNESS_FEATURE_IDS.map((id) => ({
    id,
    label: HARNESS_FEATURE_LABELS[id],
    detected: false,
    paths: [],
  }));
}

function toFeatures(detected: Map<HarnessFeatureId, Detected>): HarnessFeature[] {
  return HARNESS_FEATURE_IDS.map((id) => {
    const hit = detected.get(id);
    const feature: HarnessFeature = {
      id,
      label: HARNESS_FEATURE_LABELS[id],
      detected: hit !== undefined,
      paths: hit?.paths ?? [],
    };
    if (hit?.count !== undefined) feature.count = hit.count;
    if (hit?.note !== undefined) feature.note = hit.note;
    return feature;
  });
}

async function detectFeatures(
  ix: FileIndex,
  files: FileSource,
  manifestPathFound: string | null,
): Promise<Map<HarnessFeatureId, Detected>> {
  const found = new Map<HarnessFeatureId, Detected>();
  const set = (id: HarnessFeatureId, paths: string[], extra: Omit<Detected, 'paths'> = {}): void => {
    if (paths.length === 0) return;
    found.set(id, { paths: [...new Set(paths)], ...extra });
  };

  const settingsFiles = firstExisting(ix, CLAUDE_SETTINGS_FILES);

  set('claude_md', firstExisting(ix, ['CLAUDE.md', '.claude/CLAUDE.md']));
  set('claude_settings', settingsFiles);

  // hooks: a hooks key inside the settings files, or a .claude/hooks directory
  const hookPaths: string[] = [];
  for (const settings of settingsFiles) {
    if (await hasJsonKey(files, settings, ['hooks'])) hookPaths.push(settings);
  }
  const hookDir = underDir(ix, '.claude/hooks');
  hookPaths.push(...hookDir);
  set('claude_hooks', hookPaths, hookDir.length > 0 ? { count: hookDir.length } : {});

  const skills = matching(ix, /^\.claude\/skills\/[^/]+\/SKILL\.md$/i);
  set('claude_skills', skills, { count: skills.length });

  const subagents = matching(ix, /^\.claude\/agents\/.+\.md$/i);
  set('claude_subagents', subagents, { count: subagents.length });

  const commands = matching(ix, /^\.claude\/commands\/.+\.md$/i);
  set('claude_commands', commands, { count: commands.length });

  const plugins = [...underDir(ix, '.claude-plugin'), ...matching(ix, /^plugins\/(.+\/)?plugin\.json$/i)];
  set('claude_plugins', plugins);

  // MCP: any of the five places an agent reads server definitions from
  const mcpPaths: string[] = [];
  const dotMcp = filePath(ix, '.mcp.json');
  if (dotMcp !== null) mcpPaths.push(dotMcp);
  for (const settings of settingsFiles) {
    if (await hasJsonKey(files, settings, ['mcpServers'])) mcpPaths.push(settings);
  }
  const codexConfig = filePath(ix, '.codex/config.toml');
  if (codexConfig !== null) {
    const raw = await files.read(codexConfig, 256 * 1024);
    if (raw !== null && /^\s*\[mcp_servers(\.|\])/m.test(raw)) mcpPaths.push(codexConfig);
  }
  const geminiSettings = filePath(ix, '.gemini/settings.json');
  if (geminiSettings !== null && (await hasJsonKey(files, geminiSettings, ['mcpServers']))) {
    mcpPaths.push(geminiSettings);
  }
  const opencodeConfigPath = filePath(ix, 'opencode.json') ?? filePath(ix, 'opencode.jsonc');
  if (opencodeConfigPath !== null && (await hasJsonKey(files, opencodeConfigPath, ['mcp']))) {
    mcpPaths.push(opencodeConfigPath);
  }
  set('mcp', mcpPaths);

  set('agents_md', firstExisting(ix, ['AGENTS.md']), {
    note: 'read by Codex and, as a fallback, by several other CLIs',
  });
  set('codex_config', codexConfig === null ? [] : [codexConfig]);
  set('gemini_md', firstExisting(ix, ['GEMINI.md']));
  set('gemini_config', geminiSettings === null ? [] : [geminiSettings]);

  const opencodeConfig = [
    ...firstExisting(ix, ['opencode.json', 'opencode.jsonc']),
    ...underDir(ix, '.opencode'),
  ];
  set('opencode_config', opencodeConfig);

  const opencodeAgents = underDir(ix, '.opencode/agent');
  if (opencodeConfigPath !== null && (await hasJsonKey(files, opencodeConfigPath, ['agents', 'agent']))) {
    opencodeAgents.push(opencodeConfigPath);
  }
  set('opencode_agents', opencodeAgents);

  set('cursor_rules', [...underDir(ix, '.cursor/rules'), ...firstExisting(ix, ['.cursorrules'])]);

  if (manifestPathFound !== null) set('arena_manifest', [manifestPathFound]);

  return found;
}

function detectInstall(
  ix: FileIndex,
  commands: string[],
): { packageManager: PackageManager; runtime: Runtime; commands: string[] } {
  for (const entry of LOCKFILES) {
    if (filePath(ix, entry.file) !== null) {
      return { packageManager: entry.packageManager, runtime: entry.runtime, commands };
    }
  }
  if (filePath(ix, 'package.json') !== null) {
    // a Node project with no lockfile: Arena cannot tell which package manager to use
    return { packageManager: 'unknown', runtime: 'node', commands };
  }
  if (filePath(ix, 'pyproject.toml') !== null) {
    return { packageManager: 'unknown', runtime: 'python', commands };
  }
  return { packageManager: 'none', runtime: 'none', commands };
}

export async function inspectHarness(
  source: HarnessSource,
  files: FileSource,
  opts: InspectOptions = {},
): Promise<HarnessInspection> {
  const listing = files.listResult
    ? await files.listResult()
    : { files: await files.list(), truncated: false };
  const ix = buildIndex(listing.files, listing.truncated);

  const filenames = opts.manifestPath ? [opts.manifestPath, ...MANIFEST_FILENAMES] : MANIFEST_FILENAMES;
  const found = await findManifest(files, filenames);
  const manifest: HarnessInspection['manifest'] = {
    found: found !== null,
    path: found?.path ?? null,
    valid: found !== null && found.result.ok,
    errors: found !== null && !found.result.ok ? found.result.errors : [],
    manifest: found !== null && found.result.ok ? found.result.manifest : null,
  };

  const detected = await detectFeatures(ix, files, manifest.path);
  const features = toFeatures(detected);

  const agentsWithFeatures = new Set<AgentFramework>();
  for (const id of detected.keys()) {
    const agent = FEATURE_AGENT[id];
    if (agent) agentsWithFeatures.add(agent);
  }
  const framework: InspectionFramework =
    agentsWithFeatures.size === 0
      ? 'unknown'
      : agentsWithFeatures.size === 1
        ? ([...agentsWithFeatures][0] as AgentFramework)
        : 'multi';

  const manifestAgents = manifest.manifest?.agents;
  const agents =
    manifestAgents !== undefined && manifestAgents.length > 0
      ? [...manifestAgents]
      : [...agentsWithFeatures].sort();

  const manifestCommands = [
    manifest.manifest?.install?.command,
    manifest.manifest?.prepare?.command,
    manifest.manifest?.cleanup?.command,
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  const install = detectInstall(ix, manifestCommands);

  const declaredFiles = manifest.manifest?.files;
  const applyFiles =
    declaredFiles !== undefined
      ? [...declaredFiles]
      : AUTO_DETECT_FILES.filter((entry) => pathExists(ix, entry.path)).map((entry) => entry.path);

  const compatibility = assessCompatibility({
    manifest,
    detected,
    install,
    applyFiles,
    truncated: ix.truncated,
  });

  return {
    source,
    commit: opts.commit ?? null,
    framework,
    agents,
    manifest,
    features,
    install,
    applyFiles,
    compatibility,
    fileCount: ix.files.length,
    truncated: ix.truncated,
    inspectedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
}

function assessCompatibility(input: {
  manifest: HarnessInspection['manifest'];
  detected: Map<HarnessFeatureId, Detected>;
  install: HarnessInspection['install'];
  applyFiles: string[];
  truncated: boolean;
}): HarnessInspection['compatibility'] {
  const { manifest, detected, install, applyFiles, truncated } = input;
  const agentFeatures = [...detected.keys()].filter((id) => FEATURE_AGENT[id] !== undefined);
  const featureLabels = agentFeatures.map((id) => HARNESS_FEATURE_LABELS[id]);
  const reasons: string[] = [];

  if (manifest.found && !manifest.valid) {
    reasons.push(`${manifest.path ?? 'arena.yaml'} is present but invalid: ${manifest.errors.join('; ')}`);
    if (agentFeatures.length > 0) {
      reasons.push(`Auto-detected harness files would be used instead: ${featureLabels.join(', ')}`);
      return { status: 'partial', reasons };
    }
    reasons.push('No CLAUDE.md, AGENTS.md, GEMINI.md, opencode.json or arena.yaml found to fall back to');
    return { status: 'incompatible', reasons };
  }

  if (manifest.valid && manifest.manifest) {
    reasons.push(
      `${manifest.path ?? 'arena.yaml'} is a valid version 1 manifest (${manifest.manifest.name})`,
    );
    reasons.push(
      applyFiles.length > 0
        ? `Declares ${applyFiles.length} path(s) to apply: ${applyFiles.join(', ')}`
        : 'Declares no files to apply; the harness is commands and agent config only',
    );
    if (install.commands.length > 0) {
      reasons.push(
        `Declares ${install.commands.length} command(s), which run only after you trust the harness`,
      );
    }
    if (truncated) reasons.push('The file listing was truncated; detection may be incomplete');
    return { status: 'ready', reasons };
  }

  if (agentFeatures.length > 0) {
    reasons.push(`No arena.yaml; detected harness files: ${featureLabels.join(', ')}`);
    reasons.push(`Auto-detected paths would be applied: ${applyFiles.join(', ') || 'none'}`);
    if (truncated) reasons.push('The file listing was truncated; detection may be incomplete');
    if (install.packageManager === 'unknown' && install.commands.length === 0) {
      reasons.push(
        `Dependencies may be required (${install.runtime} project without a recognised lockfile) but neither a lockfile nor an arena.yaml install command says how to install them`,
      );
      return { status: 'partial', reasons };
    }
    return { status: 'ready', reasons };
  }

  reasons.push('No CLAUDE.md, AGENTS.md, GEMINI.md, opencode.json or arena.yaml found');
  reasons.push('Nothing would be applied to the workspace; this harness would behave like vanilla');
  if (truncated) reasons.push('The file listing was truncated; detection may be incomplete');
  return { status: 'unknown', reasons };
}

/** The inspection of `vanilla`: the agent's own defaults, nothing applied. */
export function vanillaInspection(source: HarnessSource, opts: InspectOptions = {}): HarnessInspection {
  return {
    source,
    commit: null,
    framework: 'unknown',
    agents: [],
    manifest: { found: false, path: null, valid: false, errors: [], manifest: null },
    features: emptyFeatures(),
    install: { packageManager: 'none', runtime: 'none', commands: [] },
    applyFiles: [],
    compatibility: { status: 'ready', reasons: ['agent defaults, no harness files'] },
    fileCount: 0,
    truncated: false,
    inspectedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
}
