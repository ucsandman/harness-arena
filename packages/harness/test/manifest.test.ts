import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalFileSource } from '../src/file-source';
import { findManifest, loadManifestFromDir, parseManifestYaml } from '../src/manifest';
import { makeTempDir, removeDir, writeFiles } from './helpers';

const EXAMPLE_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'examples', 'example-harness');

describe('parseManifestYaml', () => {
  it('accepts a minimal valid manifest', () => {
    const result = parseManifestYaml('arena: 1\nname: my-harness\n');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('my-harness');
      expect(result.manifest.files).toBeUndefined();
    }
  });

  it('applies command defaults', () => {
    const result = parseManifestYaml('arena: 1\nname: h\ninstall:\n  command: npm ci\n');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.install?.timeoutMs).toBe(300_000);
  });

  it('reports schema errors with their path', () => {
    const result = parseManifestYaml('arena: 2\nname: Not Lowercase\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('arena:'))).toBe(true);
      expect(result.errors.some((e) => e.startsWith('name:'))).toBe(true);
    }
  });

  it('rejects unknown keys', () => {
    const result = parseManifestYaml('arena: 1\nname: h\nsurprise: true\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/surprise/);
  });

  it('turns malformed YAML into an error instead of throwing', () => {
    const result = parseManifestYaml('arena: 1\nname: [unclosed\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/YAML parse error/);
  });

  it('never resolves a custom tag into anything but plain data', () => {
    // an unknown tag is ignored by the yaml core schema: the value stays a string, nothing is constructed
    const result = parseManifestYaml('arena: 1\nname: !!python/object:os.system h\n');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('h');
      expect(typeof result.manifest.name).toBe('string');
    }
    // and a tagged mapping cannot smuggle a non-plain value past the schema
    const tagged = parseManifestYaml('arena: 1\nname: h\nmetadata: !!python/object\n  a: 1\n');
    expect(tagged.ok).toBe(true);
    if (tagged.ok) expect(tagged.manifest.metadata).toEqual({ a: 1 });
  });

  it('reports an empty document', () => {
    const result = parseManifestYaml('# only a comment\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/empty/);
  });

  it('rejects a document that is not a mapping', () => {
    expect(parseManifestYaml('- 1\n- 2\n').ok).toBe(false);
    expect(parseManifestYaml('just a string\n').ok).toBe(false);
  });
});

describe('findManifest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it('returns null when no manifest is present', async () => {
    await writeFiles(dir, { 'README.md': 'nothing here\n' });
    expect(await findManifest(createLocalFileSource(dir))).toBeNull();
  });

  it('prefers arena.yaml over the later filenames', async () => {
    await writeFiles(dir, {
      'arena.yaml': 'arena: 1\nname: first\n',
      'arena.yml': 'arena: 1\nname: second\n',
      '.arena/arena.yaml': 'arena: 1\nname: third\n',
    });
    const found = await findManifest(createLocalFileSource(dir));
    expect(found?.path).toBe('arena.yaml');
    expect(found?.result.ok && found.result.manifest.name).toBe('first');
  });

  it('falls back through the filename list', async () => {
    await writeFiles(dir, { '.arena/arena.yaml': 'arena: 1\nname: nested\n' });
    const found = await findManifest(createLocalFileSource(dir));
    expect(found?.path).toBe('.arena/arena.yaml');
  });

  it('honours an explicit filename list', async () => {
    await writeFiles(dir, {
      'arena.yaml': 'arena: 1\nname: default-one\n',
      'custom/manifest.yaml': 'arena: 1\nname: custom-one\n',
    });
    const found = await findManifest(createLocalFileSource(dir), ['custom/manifest.yaml', 'arena.yaml']);
    expect(found?.path).toBe('custom/manifest.yaml');
    expect(found?.result.ok && found.result.manifest.name).toBe('custom-one');
  });

  it('keeps the raw text of an invalid manifest', async () => {
    await writeFiles(dir, { 'arena.yaml': 'arena: 9\nname: bad\n' });
    const found = await findManifest(createLocalFileSource(dir));
    expect(found?.raw).toBe('arena: 9\nname: bad\n');
    expect(found?.result.ok).toBe(false);
  });
});

describe('loadManifestFromDir', () => {
  it('loads the example harness manifest', async () => {
    const found = await loadManifestFromDir(EXAMPLE_DIR);
    expect(found?.path).toBe('arena.yaml');
    expect(found?.result.ok).toBe(true);
    if (found?.result.ok) {
      const manifest = found.result.manifest;
      expect(manifest.name).toBe('example-harness');
      expect(manifest.agents).toEqual(['claude-code', 'codex']);
      expect(manifest.files).toEqual(['CLAUDE.md', '.claude', 'AGENTS.md']);
      expect(manifest.install).toBeUndefined();
      expect(manifest.capabilities?.skills).toBe(true);
      expect(manifest.agentConfig?.['claude-code']?.systemPromptAppend).toBe('AGENTS.md');
    }
  });

  it('returns null for a directory without a manifest', async () => {
    const fixture = path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'examples',
      'fixtures',
      'harness-repos',
      'unknown-repo',
    );
    expect(await loadManifestFromDir(fixture)).toBeNull();
  });
});
