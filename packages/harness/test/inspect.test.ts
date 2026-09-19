import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessFeatureId, HarnessInspection } from '@harness-arena/protocol';
import { createGitHubFileSource, createLocalFileSource } from '../src/file-source';
import { inspectHarness, vanillaInspection } from '../src/inspect';
import { parseHarnessSource } from '../src/source';
import { jsonResponse, makeTempDir, removeDir, stubFetch, writeFiles } from './helpers';

const EXAMPLES = path.resolve(import.meta.dirname, '..', '..', '..', 'examples');
const EXAMPLE_HARNESS = path.join(EXAMPLES, 'example-harness');
const FIXTURES = path.join(EXAMPLES, 'fixtures', 'harness-repos');

function detected(inspection: HarnessInspection): HarnessFeatureId[] {
  return inspection.features.filter((f) => f.detected).map((f) => f.id);
}

function feature(inspection: HarnessInspection, id: HarnessFeatureId) {
  const found = inspection.features.find((f) => f.id === id);
  if (!found) throw new Error(`feature ${id} missing from the inspection`);
  return found;
}

describe('inspectHarness over the example harness', () => {
  const source = parseHarnessSource(EXAMPLE_HARNESS);
  let inspection: HarnessInspection;

  beforeEach(async () => {
    inspection = await inspectHarness(source, createLocalFileSource(EXAMPLE_HARNESS), {
      commit: 'abc1234',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
    });
  });

  it('reports every feature the example ships', () => {
    expect(detected(inspection)).toEqual(
      expect.arrayContaining([
        'claude_md',
        'claude_settings',
        'claude_hooks',
        'claude_skills',
        'claude_subagents',
        'agents_md',
        'arena_manifest',
      ]),
    );
    expect(feature(inspection, 'claude_skills').count).toBe(1);
    expect(feature(inspection, 'claude_skills').paths).toEqual(['.claude/skills/tests-first/SKILL.md']);
    expect(feature(inspection, 'claude_subagents').count).toBe(1);
    expect(feature(inspection, 'claude_hooks').paths).toContain('.claude/settings.json');
    expect(feature(inspection, 'arena_manifest').paths).toEqual(['arena.yaml']);
  });

  it('reports the features it does not have as not detected', () => {
    for (const id of ['mcp', 'claude_commands', 'claude_plugins', 'gemini_md', 'opencode_config'] as const) {
      expect(feature(inspection, id).detected, id).toBe(false);
      expect(feature(inspection, id).paths).toEqual([]);
    }
  });

  it('is a multi-agent harness that is ready to run', () => {
    expect(inspection.framework).toBe('multi');
    expect(inspection.agents).toEqual(['claude-code', 'codex']);
    expect(inspection.compatibility.status).toBe('ready');
    expect(inspection.compatibility.reasons.join(' ')).toContain('valid version 1 manifest');
  });

  it('takes applyFiles from the manifest and records the inspection metadata', () => {
    expect(inspection.applyFiles).toEqual(['CLAUDE.md', '.claude', 'AGENTS.md']);
    expect(inspection.manifest.found).toBe(true);
    expect(inspection.manifest.valid).toBe(true);
    expect(inspection.manifest.errors).toEqual([]);
    expect(inspection.install).toEqual({ packageManager: 'none', runtime: 'none', commands: [] });
    expect(inspection.commit).toBe('abc1234');
    expect(inspection.truncated).toBe(false);
    expect(inspection.fileCount).toBeGreaterThanOrEqual(6);
    expect(inspection.inspectedAt).toBe('2026-09-19T12:00:00.000Z');
    expect(inspection.source).toEqual(source);
  });
});

describe('inspectHarness over the fixtures', () => {
  it('detects a codex-only harness and its MCP servers', async () => {
    const dir = path.join(FIXTURES, 'codex-only');
    const inspection = await inspectHarness(parseHarnessSource(dir), createLocalFileSource(dir));
    expect(inspection.framework).toBe('codex');
    expect(inspection.agents).toEqual(['codex']);
    expect(detected(inspection).sort()).toEqual(['agents_md', 'codex_config', 'mcp']);
    expect(feature(inspection, 'mcp').paths).toEqual(['.codex/config.toml']);
    expect(inspection.manifest.found).toBe(false);
    expect(inspection.applyFiles).toEqual(['AGENTS.md', '.codex']);
    expect(inspection.compatibility.status).toBe('ready');
  });

  it('reports an unknown repository with reasons that say what was looked for', async () => {
    const dir = path.join(FIXTURES, 'unknown-repo');
    const inspection = await inspectHarness(parseHarnessSource(dir), createLocalFileSource(dir));
    expect(inspection.framework).toBe('unknown');
    expect(inspection.agents).toEqual([]);
    expect(detected(inspection)).toEqual([]);
    expect(inspection.applyFiles).toEqual([]);
    expect(inspection.compatibility.status).toBe('unknown');
    expect(inspection.compatibility.reasons.length).toBeGreaterThan(0);
    expect(inspection.compatibility.reasons[0]).toBe(
      'No CLAUDE.md, AGENTS.md, GEMINI.md, opencode.json or arena.yaml found',
    );
  });
});

describe('inspectHarness detection details', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  async function inspectDir(files: Record<string, string>, opts = {}): Promise<HarnessInspection> {
    await writeFiles(dir, files);
    return inspectHarness(parseHarnessSource(dir), createLocalFileSource(dir), opts);
  }

  it('detects a gemini harness with MCP from .gemini/settings.json', async () => {
    const inspection = await inspectDir({
      'GEMINI.md': '# rules\n',
      '.gemini/settings.json': '{"mcpServers":{"time":{"command":"uvx"}}}',
    });
    expect(inspection.framework).toBe('gemini-cli');
    expect(detected(inspection).sort()).toEqual(['gemini_config', 'gemini_md', 'mcp']);
  });

  it('detects an opencode harness, including agents declared inside the config', async () => {
    const inspection = await inspectDir({
      'opencode.json': '{"$schema":"x","mcp":{"a":{}},"agents":{"reviewer":{}}}',
      '.opencode/agent/reviewer.md': 'review\n',
    });
    expect(inspection.framework).toBe('opencode');
    expect(detected(inspection).sort()).toEqual(['mcp', 'opencode_agents', 'opencode_config']);
    expect(feature(inspection, 'opencode_agents').paths).toContain('.opencode/agent/reviewer.md');
  });

  it('detects hooks from a hooks directory and commands, skills and plugins by count', async () => {
    const inspection = await inspectDir({
      'CLAUDE.md': '# rules\n',
      '.claude/hooks/pre-tool.cjs': 'module.exports = {};\n',
      '.claude/commands/ship.md': 'ship it\n',
      '.claude/commands/nested/deep.md': 'deep\n',
      '.claude/skills/a/SKILL.md': 'a\n',
      '.claude/skills/b/SKILL.md': 'b\n',
      '.claude-plugin/plugin.json': '{}',
      '.cursorrules': 'be nice\n',
      '.mcp.json': '{"mcpServers":{}}',
    });
    expect(inspection.framework).toBe('claude-code');
    expect(feature(inspection, 'claude_hooks').paths).toEqual(['.claude/hooks/pre-tool.cjs']);
    expect(feature(inspection, 'claude_commands').count).toBe(2);
    expect(feature(inspection, 'claude_skills').count).toBe(2);
    expect(feature(inspection, 'claude_plugins').detected).toBe(true);
    expect(feature(inspection, 'cursor_rules').detected).toBe(true);
    expect(feature(inspection, 'mcp').paths).toEqual(['.mcp.json']);
  });

  it('does not claim hooks or MCP when the settings file has neither', async () => {
    const inspection = await inspectDir({
      'CLAUDE.md': '# rules\n',
      '.claude/settings.json': '{"permissions":{"allow":[]}}',
    });
    expect(feature(inspection, 'claude_settings').detected).toBe(true);
    expect(feature(inspection, 'claude_hooks').detected).toBe(false);
    expect(feature(inspection, 'mcp').detected).toBe(false);
  });

  it('detects the package manager from a lockfile and lists manifest commands', async () => {
    const inspection = await inspectDir({
      'CLAUDE.md': '# rules\n',
      'package.json': '{"name":"h"}',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'arena.yaml':
        'arena: 1\nname: h\ninstall:\n  command: pnpm install --frozen-lockfile\nprepare:\n  command: node scripts/prepare.mjs\n',
    });
    expect(inspection.install.packageManager).toBe('pnpm');
    expect(inspection.install.runtime).toBe('node');
    expect(inspection.install.commands).toEqual([
      'pnpm install --frozen-lockfile',
      'node scripts/prepare.mjs',
    ]);
    expect(inspection.compatibility.status).toBe('ready');
    expect(inspection.compatibility.reasons.join(' ')).toContain('only after you trust');
  });

  it('is partial when an installable project has no lockfile and no install command', async () => {
    const inspection = await inspectDir({ 'CLAUDE.md': '# rules\n', 'package.json': '{"name":"h"}' });
    expect(inspection.install.packageManager).toBe('unknown');
    expect(inspection.compatibility.status).toBe('partial');
    expect(inspection.compatibility.reasons.join(' ')).toContain('lockfile');
  });

  it('is partial when the manifest is invalid but harness files exist', async () => {
    const inspection = await inspectDir({ 'CLAUDE.md': '# rules\n', 'arena.yaml': 'arena: 4\nname: nope\n' });
    expect(inspection.manifest.found).toBe(true);
    expect(inspection.manifest.valid).toBe(false);
    expect(inspection.manifest.errors.length).toBeGreaterThan(0);
    expect(inspection.compatibility.status).toBe('partial');
    expect(inspection.applyFiles).toEqual(['CLAUDE.md']);
  });

  it('is incompatible when the manifest is invalid and there is nothing to fall back to', async () => {
    const inspection = await inspectDir({ 'README.md': 'hi\n', 'arena.yaml': 'arena: 1\n' });
    expect(inspection.compatibility.status).toBe('incompatible');
    expect(inspection.compatibility.reasons.join(' ')).toContain('invalid');
  });

  it('honours an explicit manifest path', async () => {
    const inspection = await inspectDir(
      { 'CLAUDE.md': '# rules\n', 'harness/arena.yaml': 'arena: 1\nname: explicit\n' },
      { manifestPath: 'harness/arena.yaml' },
    );
    expect(inspection.manifest.path).toBe('harness/arena.yaml');
    expect(inspection.manifest.valid).toBe(true);
  });

  it('auto-detects apply files when the manifest omits them', async () => {
    const inspection = await inspectDir({
      'arena.yaml': 'arena: 1\nname: h\n',
      'CLAUDE.md': '# rules\n',
      '.claude/settings.json': '{}',
      'AGENTS.md': 'a\n',
      '.mcp.json': '{}',
      'unrelated.txt': 'x\n',
    });
    expect(inspection.applyFiles).toEqual(['CLAUDE.md', '.claude', '.mcp.json', 'AGENTS.md']);
  });

  it('carries the truncated flag through to the inspection', async () => {
    await writeFiles(dir, { 'CLAUDE.md': '# rules\n', 'AGENTS.md': 'a\n', 'README.md': 'r\n' });
    const inspection = await inspectHarness(
      parseHarnessSource(dir),
      createLocalFileSource(dir, { maxFiles: 1 }),
      {},
    );
    expect(inspection.truncated).toBe(true);
    expect(inspection.fileCount).toBe(1);
    expect(inspection.compatibility.reasons.join(' ')).toContain('truncated');
  });
});

describe('inspectHarness over a GitHub file source', () => {
  it('inspects without touching the filesystem', async () => {
    const { fetchImpl } = stubFetch((url) => {
      if (url.endsWith('/repos/o/r')) return jsonResponse({ default_branch: 'main' });
      if (url.includes('/git/trees/main'))
        return jsonResponse({
          truncated: false,
          tree: [
            { path: 'CLAUDE.md', type: 'blob' },
            { path: 'arena.yaml', type: 'blob' },
          ],
        });
      if (url.includes('/contents/arena.yaml')) return new Response('arena: 1\nname: remote-harness\n');
      throw new Error(`unexpected url ${url}`);
    });
    const source = parseHarnessSource('https://github.com/o/r');
    const inspection = await inspectHarness(
      source,
      createGitHubFileSource({ owner: 'o', repo: 'r', fetchImpl }),
    );
    expect(inspection.framework).toBe('claude-code');
    expect(inspection.manifest.valid).toBe(true);
    expect(inspection.manifest.manifest?.name).toBe('remote-harness');
    expect(inspection.applyFiles).toEqual(['CLAUDE.md']);
    expect(inspection.compatibility.status).toBe('ready');
  });
});

describe('vanillaInspection', () => {
  it('is ready with no files and no framework', () => {
    const inspection = vanillaInspection(parseHarnessSource('vanilla'), {
      now: () => new Date('2026-09-19T00:00:00.000Z'),
    });
    expect(inspection.framework).toBe('unknown');
    expect(inspection.compatibility).toEqual({
      status: 'ready',
      reasons: ['agent defaults, no harness files'],
    });
    expect(inspection.features).toHaveLength(16);
    expect(inspection.features.every((f) => !f.detected)).toBe(true);
    expect(inspection.applyFiles).toEqual([]);
    expect(inspection.inspectedAt).toBe('2026-09-19T00:00:00.000Z');
  });
});
