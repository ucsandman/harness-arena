import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cloneUrl,
  harnessDisplayName,
  HarnessSourceError,
  normalizeSourceKey,
  parseGitHubUrl,
  parseHarnessSource,
  sourceCacheKey,
} from '../src/source';

describe('parseGitHubUrl', () => {
  const accepted: Array<[string, { owner: string; repo: string; ref: string | null; path: string | null }]> =
    [
      [
        'https://github.com/ucsandman/agnostic-ai',
        { owner: 'ucsandman', repo: 'agnostic-ai', ref: null, path: null },
      ],
      [
        'https://github.com/ucsandman/agnostic-ai.git',
        { owner: 'ucsandman', repo: 'agnostic-ai', ref: null, path: null },
      ],
      [
        'https://github.com/ucsandman/agnostic-ai/',
        { owner: 'ucsandman', repo: 'agnostic-ai', ref: null, path: null },
      ],
      ['  https://github.com/o/r  ', { owner: 'o', repo: 'r', ref: null, path: null }],
      ['http://github.com/o/r', { owner: 'o', repo: 'r', ref: null, path: null }],
      ['https://www.github.com/o/r', { owner: 'o', repo: 'r', ref: null, path: null }],
      ['https://github.com/o/r/tree/main', { owner: 'o', repo: 'r', ref: 'main', path: null }],
      ['https://github.com/o/r/tree/main/', { owner: 'o', repo: 'r', ref: 'main', path: null }],
      ['https://github.com/o/r/tree/main/harness', { owner: 'o', repo: 'r', ref: 'main', path: 'harness' }],
      [
        'https://github.com/o/r/tree/v1.2.3/deep/nested/dir',
        { owner: 'o', repo: 'r', ref: 'v1.2.3', path: 'deep/nested/dir' },
      ],
      ['https://github.com/o/r/blob/main/arena.yaml', { owner: 'o', repo: 'r', ref: 'main', path: null }],
      [
        'https://github.com/o/r/blob/main/harness/sub/arena.yaml',
        { owner: 'o', repo: 'r', ref: 'main', path: 'harness/sub' },
      ],
      ['git@github.com:o/r.git', { owner: 'o', repo: 'r', ref: null, path: null }],
      ['git@github.com:o/r', { owner: 'o', repo: 'r', ref: null, path: null }],
      ['GIT@GitHub.com:Owner/Repo.git', { owner: 'Owner', repo: 'Repo', ref: null, path: null }],
      ['ssh://git@github.com/o/r.git', { owner: 'o', repo: 'r', ref: null, path: null }],
      ['github:o/r', { owner: 'o', repo: 'r', ref: null, path: null }],
      ['github:ucsandman/agnostic-ai', { owner: 'ucsandman', repo: 'agnostic-ai', ref: null, path: null }],
      ['github:o/r/tree/dev/pkg', { owner: 'o', repo: 'r', ref: 'dev', path: 'pkg' }],
      ['https://github.com/o/r.GIT', { owner: 'o', repo: 'r', ref: null, path: null }],
    ];

  for (const [input, expected] of accepted) {
    it(`accepts ${input}`, () => {
      const parsed = parseGitHubUrl(input);
      expect(parsed, input).not.toBeNull();
      expect({ owner: parsed?.owner, repo: parsed?.repo, ref: parsed?.ref, path: parsed?.path }).toEqual(
        expected,
      );
      expect(parsed?.url).toBe(`https://github.com/${expected.owner}/${expected.repo}`);
    });
  }

  const rejected: string[] = [
    '',
    '   ',
    'vanilla',
    'not a url at all',
    'https://gitlab.com/o/r',
    'https://bitbucket.org/o/r.git',
    'https://githubusercontent.com/o/r',
    'https://github.example.com/o/r',
    'https://github.com/onlyowner',
    'https://github.com/',
    'https://github.com/o/r/pull/12',
    'https://github.com/o/r/tree',
    'https://github.com/o/r/tree/',
    'https://github.com/../r',
    'https://github.com/o/r/tree/main/../secret',
    'https://user:pass@github.com/o/r',
    'https://ghp_exampletoken@github.com/o/r.git',
    'https://x-access-token:ghs_token@github.com/o/r.git',
    'deploy@github.com:o/r.git',
    'git@gitlab.com:o/r.git',
    'file:///tmp/harness',
    'C:\\Projects\\harness',
    './local/harness',
  ];

  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(parseGitHubUrl(input)).toBeNull();
    });
  }
});

describe('parseHarnessSource', () => {
  it('recognises vanilla case-insensitively', () => {
    expect(parseHarnessSource('vanilla')).toEqual({ kind: 'vanilla' });
    expect(parseHarnessSource('VANILLA')).toEqual({ kind: 'vanilla' });
    expect(parseHarnessSource(' Vanilla ')).toEqual({ kind: 'vanilla' });
  });

  it('recognises vanilla:<agent>', () => {
    expect(parseHarnessSource('vanilla:claude-code')).toEqual({ kind: 'vanilla', agent: 'claude-code' });
    expect(parseHarnessSource('Vanilla:CODEX')).toEqual({ kind: 'vanilla', agent: 'codex' });
    expect(parseHarnessSource('vanilla:')).toEqual({ kind: 'vanilla' });
  });

  it('recognises GitHub sources', () => {
    expect(parseHarnessSource('https://github.com/o/r/tree/main/pkg')).toEqual({
      kind: 'github',
      url: 'https://github.com/o/r',
      owner: 'o',
      repo: 'r',
      ref: 'main',
      path: 'pkg',
    });
  });

  it('recognises other git URLs', () => {
    expect(parseHarnessSource('https://gitlab.com/o/r.git')).toEqual({
      kind: 'git',
      url: 'https://gitlab.com/o/r.git',
      ref: null,
    });
    expect(parseHarnessSource('ssh://git@example.com/o/r.git')).toEqual({
      kind: 'git',
      url: 'ssh://git@example.com/o/r.git',
      ref: null,
    });
    expect(parseHarnessSource('me@git.example.com:o/r.git')).toEqual({
      kind: 'git',
      url: 'me@git.example.com:o/r.git',
      ref: null,
    });
  });

  it('refuses git URLs carrying credentials', () => {
    expect(() => parseHarnessSource('https://user:pass@gitlab.com/o/r.git')).toThrow(HarnessSourceError);
    expect(() => parseHarnessSource('https://token@gitlab.com/o/r.git')).toThrow(/credentials/);
  });

  it('treats anything else as a local path, resolved to absolute', () => {
    const relative = parseHarnessSource('./my-harness');
    expect(relative).toEqual({ kind: 'local', path: path.resolve('./my-harness') });
    const absolute = parseHarnessSource(path.resolve('harnesses', 'a'));
    expect(absolute).toEqual({ kind: 'local', path: path.resolve('harnesses', 'a') });
  });

  it('rejects an empty source', () => {
    expect(() => parseHarnessSource('   ')).toThrow(HarnessSourceError);
  });
});

describe('harnessDisplayName', () => {
  it('names each kind', () => {
    expect(harnessDisplayName(parseHarnessSource('https://github.com/ucsandman/agnostic-ai'))).toBe(
      'ucsandman/agnostic-ai',
    );
    expect(harnessDisplayName(parseHarnessSource('vanilla'))).toBe('vanilla');
    expect(harnessDisplayName(parseHarnessSource('https://gitlab.com/o/my-harness.git'))).toBe('my-harness');
    expect(harnessDisplayName(parseHarnessSource(path.join('some', 'dir', 'my-local-harness')))).toBe(
      'my-local-harness',
    );
  });
});

describe('sourceCacheKey', () => {
  it('is a stable sha1 hex digest', () => {
    const source = parseHarnessSource('https://github.com/o/r');
    expect(sourceCacheKey(source)).toMatch(/^[0-9a-f]{40}$/);
    expect(sourceCacheKey(source)).toBe(sourceCacheKey(parseHarnessSource('https://github.com/O/R.git')));
  });

  it('separates different repositories, refs and subdirectories', () => {
    const keys = new Set(
      [
        'https://github.com/o/r',
        'https://github.com/o/other',
        'https://github.com/o/r/tree/dev',
        'https://github.com/o/r/tree/dev/pkg',
        'vanilla',
        'vanilla:codex',
      ].map((s) => sourceCacheKey(parseHarnessSource(s))),
    );
    expect(keys.size).toBe(6);
  });

  it('normalizes into a readable key', () => {
    expect(normalizeSourceKey(parseHarnessSource('https://github.com/O/R/tree/dev/pkg'))).toBe(
      'github:o/r@dev:pkg',
    );
  });
});

describe('cloneUrl', () => {
  it('is an https URL for GitHub and verbatim for other git sources', () => {
    expect(cloneUrl(parseHarnessSource('github:o/r'))).toBe('https://github.com/o/r.git');
    expect(cloneUrl(parseHarnessSource('https://gitlab.com/o/r.git'))).toBe('https://gitlab.com/o/r.git');
    expect(cloneUrl(parseHarnessSource('vanilla'))).toBeNull();
  });
});
