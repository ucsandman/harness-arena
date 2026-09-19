import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DOC_PAGES,
  docHref,
  docNeighbours,
  extractHeadings,
  findDocPage,
  findRepoRoot,
  loadDocPage,
  readDocFile,
  safeDocFilePath,
  slugifyHeading,
} from '../lib/docs';

const tempRoots: string[] = [];

function makeFakeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-docs-'));
  tempRoots.push(root);
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'README.md'), '# Overview\n', 'utf8');
  writeFileSync(path.join(root, 'secret.md'), 'do not read me\n', 'utf8');
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('doc registry', () => {
  it('has unique slugs, an overview at the root, and only markdown inside docs/', () => {
    const slugs = DOC_PAGES.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs[0]).toBe('');
    for (const page of DOC_PAGES) {
      expect(page.file.startsWith('docs/')).toBe(true);
      expect(page.file.endsWith('.md')).toBe(true);
      expect(page.title.length).toBeGreaterThan(0);
      expect(page.description.length).toBeGreaterThan(0);
    }
  });

  it('builds hrefs and neighbours from registry order', () => {
    const overview = DOC_PAGES[0]!;
    const second = DOC_PAGES[1]!;
    expect(docHref(overview)).toBe('/docs');
    expect(docHref(second)).toBe(`/docs/${second.slug}`);
    expect(docNeighbours(overview).prev).toBeNull();
    expect(docNeighbours(overview).next?.slug).toBe(second.slug);
    expect(docNeighbours(DOC_PAGES[DOC_PAGES.length - 1]!).next).toBeNull();
  });
});

describe('findDocPage', () => {
  it('resolves known slugs from an array or a string', () => {
    expect(findDocPage()?.slug).toBe('');
    expect(findDocPage([])?.slug).toBe('');
    expect(findDocPage(['architecture'])?.title).toBe('Architecture');
    expect(findDocPage('privacy')?.title).toBe('Privacy');
  });

  it('rejects unknown slugs and traversal attempts', () => {
    expect(findDocPage(['..', '..', 'etc', 'passwd'])).toBeNull();
    expect(findDocPage(['../../.env'])).toBeNull();
    expect(findDocPage(['architecture', 'extra'])).toBeNull();
    expect(findDocPage(['ARCHITECTURE'])).toBeNull();
    expect(findDocPage(['a'.repeat(200)])).toBeNull();
  });
});

describe('safeDocFilePath', () => {
  it('accepts markdown inside the docs directory', () => {
    const root = makeFakeRepo();
    const resolved = safeDocFilePath(root, 'docs/README.md');
    expect(resolved).toBe(path.resolve(root, 'docs', 'README.md'));
  });

  it('refuses anything outside docs/ or not markdown', () => {
    const root = makeFakeRepo();
    expect(safeDocFilePath(root, 'secret.md')).toBeNull();
    expect(safeDocFilePath(root, 'docs/../secret.md')).toBeNull();
    expect(safeDocFilePath(root, '../../../../etc/hosts.md')).toBeNull();
    expect(safeDocFilePath(root, 'docs/notes.txt')).toBeNull();
    expect(safeDocFilePath(root, 'docs')).toBeNull();
  });
});

describe('repo root and file reading', () => {
  it('finds the workspace root from a nested directory', () => {
    const root = makeFakeRepo();
    const nested = path.join(root, 'apps', 'web', 'app');
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(root);
  });

  it('returns null when there is no workspace marker', () => {
    const orphan = mkdtempSync(path.join(os.tmpdir(), 'arena-orphan-'));
    tempRoots.push(orphan);
    expect(findRepoRoot(orphan)).toBeNull();
  });

  it('reads the real overview doc from this repository', async () => {
    const overview = DOC_PAGES[0]!;
    const markdown = await readDocFile(overview);
    expect(markdown).toContain('Harness Arena');
  });

  it('returns a page with markdown null when the file is not written yet', async () => {
    const loaded = await loadDocPage(['contributing']);
    expect(loaded).not.toBeNull();
    expect(loaded?.page.title).toBe('Contributing');
    // docs/CONTRIBUTING.md arrives in a later wave; the page must not crash without it.
    expect(loaded?.markdown === null || typeof loaded?.markdown === 'string').toBe(true);
  });

  it('returns null for an unknown slug instead of reading anything', async () => {
    expect(await loadDocPage(['..', 'package.json'])).toBeNull();
  });
});

describe('headings', () => {
  it('slugifies heading text', () => {
    expect(slugifyHeading('Battle lifecycle')).toBe('battle-lifecycle');
    expect(slugifyHeading('Three execution modes!')).toBe('three-execution-modes');
    expect(slugifyHeading('  Telemetry honesty  ')).toBe('telemetry-honesty');
  });

  it('extracts h2 and h3 headings and skips fenced code', () => {
    const markdown = ['# Title', '## First', 'text', '```', '## Not a heading', '```', '### Nested', ''].join(
      '\n',
    );
    expect(extractHeadings(markdown)).toEqual([
      { depth: 2, text: 'First', id: 'first' },
      { depth: 3, text: 'Nested', id: 'nested' },
    ]);
  });
});
