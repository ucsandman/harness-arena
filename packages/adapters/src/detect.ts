import path from 'node:path';
import { defaultProcessRunner } from './process.js';
import { lookupOnPath } from './resolve.js';
import { extractVersion } from './shared.js';
import type { AdapterRegistry, Detection, ProcessRunner } from './types.js';

export const VERSION_TIMEOUT_MS = 15_000;
const VERSION_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Locate a CLI on PATH. Returns an absolute path or null; never throws.
 * On Windows this resolves `.cmd`/`.exe` shims through PATHEXT, which is how npm-installed agent CLIs
 * appear. Only absolute PATH entries are searched: the working directory is never consulted, so a
 * binary dropped in a battle workspace can never stand in for the real CLI.
 */
export async function findBinary(
  names: readonly string[],
  env: Record<string, string | undefined> = process.env,
  options: { platform?: NodeJS.Platform } = {},
): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? env.path;
  const pathExt = env.PATHEXT ?? env.Pathext ?? process.env.PATHEXT;
  for (const name of names) {
    if (!name) continue;
    const found = await lookupOnPath(name, {
      path: pathValue,
      pathExt,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
    if (found !== null) return path.resolve(found);
  }
  return null;
}

export interface VersionOptions {
  runner?: ProcessRunner;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Run `<binary> --version` and return the first non-empty output line. Some CLIs print the version
 * on stderr, so both streams are considered. Returns null when the binary cannot be run.
 */
export async function getVersionOf(
  binary: string,
  args: readonly string[] = ['--version'],
  options: VersionOptions = {},
): Promise<string | null> {
  const runner = options.runner ?? defaultProcessRunner;
  const controller = new AbortController();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (typeof value === 'string') env[key] = value;
  }

  const result = await runner.run({
    command: binary,
    args: [...args],
    cwd: options.cwd ?? process.cwd(),
    env,
    stdin: null,
    signal: controller.signal,
    timeoutMs: options.timeoutMs ?? VERSION_TIMEOUT_MS,
    maxOutputBytes: VERSION_MAX_OUTPUT_BYTES,
    onStdoutLine: (line) => stdout.push(line),
    onStderrLine: (line) => stderr.push(line),
  });

  if (result.spawnError) return null;
  const first = [...stdout, ...stderr].map((l) => l.trim()).find((l) => l.length > 0);
  return first ?? null;
}

/** `getVersionOf` plus semver extraction: `2.1.278 (Claude Code)` -> `2.1.278`. */
export async function getSemverOf(
  binary: string,
  args: readonly string[] = ['--version'],
  options: VersionOptions = {},
): Promise<string | null> {
  return extractVersion(await getVersionOf(binary, args, options));
}

/** Detect every registered adapter in parallel. A throwing adapter reports as not installed. */
export async function detectAgents(
  registry: AdapterRegistry,
  env: Record<string, string | undefined> = process.env,
): Promise<Detection[]> {
  return Promise.all(
    registry.list().map(async (adapter) => {
      try {
        return await adapter.detect(env);
      } catch (err) {
        const detection: Detection = {
          id: adapter.id,
          installed: false,
          path: null,
          version: null,
          auth: 'unknown',
          notes: [`detection failed: ${err instanceof Error ? err.message : String(err)}`],
        };
        return detection;
      }
    }),
  );
}
