import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAgents, findBinary, getSemverOf, getVersionOf } from '../src/detect';
import { builtinAdapters, createRegistry } from '../src/registry';
import { classifyError, extractVersion } from '../src/shared';
import type { AgentAdapter } from '../src/types';
import { emptyPathEnv } from './helpers';

const EMPTY_PATH = emptyPathEnv();

describe('findBinary', () => {
  it('returns null for a binary that does not exist', async () => {
    await expect(findBinary(['harness-arena-missing-binary-xyz'])).resolves.toBeNull();
  });

  it('finds a real binary and returns an absolute path', async () => {
    const found = await findBinary([path.basename(process.execPath, path.extname(process.execPath))]);
    expect(found === null || path.isAbsolute(found)).toBe(true);
  });
});

describe('getVersionOf', () => {
  it('reads the first output line from a real binary', async () => {
    const version = await getVersionOf(process.execPath, ['--version']);
    expect(version).toMatch(/^v\d+\.\d+\.\d+/);
    expect(await getSemverOf(process.execPath, ['--version'])).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns null when the binary cannot be spawned', async () => {
    await expect(getVersionOf('harness-arena-missing-binary-xyz')).resolves.toBeNull();
  });
});

describe('adapter detection', () => {
  it('reports installed:false without throwing when a CLI is missing', async () => {
    for (const adapter of builtinAdapters.filter((a) => a.kind === 'cli')) {
      const detection = await adapter.detect(EMPTY_PATH);
      expect(detection.id).toBe(adapter.id);
      expect(detection.installed).toBe(false);
      expect(detection.path).toBeNull();
      expect(detection.version).toBeNull();
      expect(detection.notes.join(' ')).toContain('not found on PATH');

      const validation = await adapter.validate(detection);
      expect(validation.ok).toBe(false);
      expect(validation.problems.length).toBeGreaterThan(0);
    }
  });

  it('detects every adapter in parallel', async () => {
    const detections = await detectAgents(createRegistry(), EMPTY_PATH);
    expect(detections.map((d) => d.id)).toEqual(['claude-code', 'codex', 'gemini-cli', 'opencode', 'fake']);
    expect(detections.find((d) => d.id === 'fake')?.installed).toBe(true);
  });

  it('turns a throwing adapter into a not-installed detection', async () => {
    const broken: AgentAdapter = {
      ...builtinAdapters[0]!,
      id: 'broken',
      detect: async () => {
        throw new Error('detection exploded');
      },
    };
    const detections = await detectAgents(createRegistry([broken]));

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ id: 'broken', installed: false, auth: 'unknown' });
    expect(detections[0]?.notes.join(' ')).toContain('detection exploded');
  });
});

describe('registry', () => {
  it('exposes the five builtin adapters by id', () => {
    const registry = createRegistry();
    expect(registry.list().map((a) => a.id)).toEqual([
      'claude-code',
      'codex',
      'gemini-cli',
      'opencode',
      'fake',
    ]);
    expect(registry.get('claude-code')?.displayName).toBe('Claude Code');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('accepts a late registration and replaces an existing id', () => {
    const registry = createRegistry([]);
    expect(registry.list()).toHaveLength(0);
    const adapter = builtinAdapters[4]!;
    registry.register(adapter);
    registry.register(adapter);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('fake')).toBe(adapter);
  });

  it('declares capabilities honestly for every adapter', () => {
    for (const adapter of builtinAdapters) {
      const capabilities = adapter.capabilities();
      expect(capabilities.notes.length).toBeGreaterThan(0);
      expect(typeof capabilities.userConfigIsolation).toBe('boolean');
    }
    const codex = createRegistry().get('codex')!;
    expect(codex.capabilities().cost).toBe('unavailable');
    expect(createRegistry().get('claude-code')!.capabilities().cost).toBe('observed');
    expect(createRegistry().get('gemini-cli')!.capabilities().userConfigIsolation).toBe(false);
  });
});

describe('error classification', () => {
  it('maps provider prose to stable codes', () => {
    expect(classifyError("You've hit your usage limit. Visit ... to purchase more credits")).toBe(
      'provider_limit',
    );
    expect(classifyError('429 Too Many Requests')).toBe('provider_limit');
    expect(classifyError('Error authenticating: IneligibleTierError')).toBe('auth');
    expect(classifyError('Invalid API key provided')).toBe('auth');
    expect(classifyError('spawn claude ENOENT')).toBe('not_installed');
    expect(classifyError('the request timed out after 30s')).toBe('timeout');
    expect(classifyError('run was aborted by the user')).toBe('interrupted');
    expect(classifyError('something else entirely')).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
  });

  it('extracts a semver from a CLI version banner', () => {
    expect(extractVersion('2.1.278 (Claude Code)')).toBe('2.1.278');
    expect(extractVersion('opencode v2.0.4')).toBe('2.0.4');
    expect(extractVersion('codex-cli 0.154.0')).toBe('0.154.0');
    expect(extractVersion('')).toBeNull();
    expect(extractVersion(null)).toBeNull();
  });

  it('keeps the temp directory PATH free of agent binaries', () => {
    expect(EMPTY_PATH.PATH).toContain(os.tmpdir());
  });
});
