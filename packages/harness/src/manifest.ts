import { MANIFEST_FILENAMES, validateManifest } from '@harness-arena/protocol';
import { parse as parseYamlDocument } from 'yaml';
import { createLocalFileSource, type FileSource } from './file-source.js';

/** Loading and validating `arena.yaml` (the Harness Adapter Protocol, version 1). */

export type ManifestValidation = ReturnType<typeof validateManifest>;

export interface FoundManifest {
  /** repository-relative path the manifest was read from */
  path: string;
  raw: string;
  result: ManifestValidation;
}

export const MANIFEST_MAX_BYTES = 128 * 1024;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse manifest YAML and validate it against the protocol schema. Parsing is data-only: the default
 * YAML 1.2 core schema with custom tags disabled, so no tag can construct anything.
 */
export function parseManifestYaml(raw: string): ManifestValidation {
  let data: unknown;
  try {
    data = parseYamlDocument(raw, { customTags: [], version: '1.2' });
  } catch (err) {
    return { ok: false, errors: [`(root): YAML parse error: ${errMessage(err)}`] };
  }
  if (data === null || data === undefined) {
    return { ok: false, errors: ['(root): the manifest is empty'] };
  }
  return validateManifest(data);
}

/** First manifest filename that exists, with its validation result. Null when none is present. */
export async function findManifest(
  files: FileSource,
  filenames: readonly string[] = MANIFEST_FILENAMES,
): Promise<FoundManifest | null> {
  for (const name of filenames) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (!(await files.exists(name))) continue;
    const raw = await files.read(name, MANIFEST_MAX_BYTES);
    if (raw === null) continue;
    return { path: name, raw, result: parseManifestYaml(raw) };
  }
  return null;
}

export function loadManifestFromDir(
  dir: string,
  filenames?: readonly string[],
): Promise<FoundManifest | null> {
  return findManifest(createLocalFileSource(dir), filenames);
}
