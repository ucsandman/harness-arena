import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRedactedManifestEnv } from '@harness-arena/core';
import {
  createGitHubFileSource,
  createLocalFileSource,
  describeExecution,
  harnessDisplayName,
  inspectHarness,
  parseHarnessSource,
  vanillaInspection,
} from '@harness-arena/harness';
import type { ResolvedHarness } from '@harness-arena/harness';
import type { HarnessInspection, HarnessSource } from '@harness-arena/protocol';

/**
 * Harness inspection for the MCP surface. Reading only: a local path is walked, a GitHub harness is
 * read through the REST API, and nothing is ever cloned, applied or executed. `execution` reports the
 * commands applying this harness *would* run so a client can show them before asking for trust.
 */

export interface InspectOutcome {
  mode: 'local' | 'github' | 'vanilla';
  source: HarnessSource;
  /** the git ref the inspection actually read, when the source kind knows one */
  ref: string | null;
  name: string;
  inspection: HarnessInspection;
  execution: { commands: string[]; files: string[] };
  /** true when applying this harness would run commands, which needs an explicit trust flag */
  trustRequired: boolean;
}

function outcomeOf(
  mode: InspectOutcome['mode'],
  source: HarnessSource,
  ref: string | null,
  dir: string | null,
  read: HarnessInspection,
): InspectOutcome {
  // arena.yaml can put a credential in agentConfig.<agent>.env. The names are disclosed, the values
  // are not: core strips them on a battle record, and this is the same boundary for every tool answer
  // built from an inspection (arena_inspect_harness, arena_list_harnesses, the inspectSource export).
  const manifest = withRedactedManifestEnv(read.manifest.manifest);
  const inspection: HarnessInspection = { ...read, manifest: { ...read.manifest, manifest } };
  const resolved: ResolvedHarness = {
    name: manifest?.name ?? harnessDisplayName(source),
    kind: source.kind,
    source,
    dir,
    commit: inspection.commit,
    manifest,
    inspection,
  };
  const execution = describeExecution(resolved);
  return {
    mode,
    source,
    ref,
    name: resolved.name,
    inspection,
    execution,
    trustRequired: execution.commands.length > 0,
  };
}

export interface InspectSourceOptions {
  source: string;
  ref?: string | null;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export async function inspectSource(opts: InspectSourceOptions): Promise<InspectOutcome> {
  const parsed = parseHarnessSource(opts.source);

  if (parsed.kind === 'vanilla') {
    return outcomeOf('vanilla', parsed, null, null, vanillaInspection(parsed));
  }

  if (parsed.kind === 'local') {
    const dir = path.resolve(parsed.path);
    const stat = await fsp.stat(dir).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      throw new Error('harness path is not a directory: ' + dir);
    }
    const inspection = await inspectHarness(parsed, createLocalFileSource(dir));
    return outcomeOf('local', parsed, null, dir, inspection);
  }

  if (parsed.kind === 'github') {
    const files = createGitHubFileSource({
      owner: parsed.owner,
      repo: parsed.repo,
      ref: opts.ref ?? parsed.ref ?? null,
      path: parsed.path,
      token: opts.env.GITHUB_TOKEN ?? opts.env.GH_TOKEN ?? null,
      fetchImpl: opts.fetchImpl,
    });
    const ref = await files.resolveRef();
    const inspection = await inspectHarness(parsed, files);
    return outcomeOf('github', parsed, ref, null, inspection);
  }

  throw new Error(
    'inspecting a plain git URL would require a clone, which this server never does. Clone it yourself ' +
      'and inspect the local path, or use a github.com URL.',
  );
}

/** `url = ...` out of a clone's .git/config, so a cached harness can name its own source. */
export async function readCloneUrl(dir: string): Promise<string | null> {
  const config = await fsp.readFile(path.join(dir, '.git', 'config'), 'utf8').catch(() => null);
  if (config === null) return null;
  const match = /^\s*url\s*=\s*(.+)$/m.exec(config);
  return match ? (match[1] as string).trim() : null;
}

/**
 * The example harness shipped in the repository checkout, when this package is running from source.
 * Both `src/tools` and `dist/tools` sit two levels inside the package, so the repository root is the
 * same relative distance from either.
 */
export function defaultExampleHarnessDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../examples/example-harness'),
    path.resolve(process.cwd(), 'examples/example-harness'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'arena.yaml'))) return candidate;
  }
  return null;
}
