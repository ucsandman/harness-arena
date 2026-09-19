import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Docs are markdown files in the repository's docs/ directory. Only files listed in DOC_PAGES can be
 * read, the path is re-validated against the docs directory after resolution, and nothing outside it
 * is reachable no matter what the URL says.
 */

export interface DocPage {
  /** URL segment under /docs; '' is the overview at /docs */
  slug: string;
  title: string;
  description: string;
  /** repo-relative path, always inside docs/ and always .md */
  file: string;
}

export const DOC_PAGES: readonly DocPage[] = [
  {
    slug: '',
    title: 'Overview',
    description: 'What Harness Arena is, how a battle works, and where to go next.',
    file: 'docs/README.md',
  },
  {
    slug: 'cli',
    title: 'Getting started / CLI',
    description: 'Install the arena CLI and run your first battle on your own machine.',
    file: 'docs/CLI.md',
  },
  {
    slug: 'architecture',
    title: 'Architecture',
    description: 'How the engine, adapters, evaluator and web app fit together.',
    file: 'docs/ARCHITECTURE.md',
  },
  {
    slug: 'protocol',
    title: 'Event protocol',
    description: 'The versioned event envelope every adapter emits and every report reads.',
    file: 'docs/PROTOCOL.md',
  },
  {
    slug: 'harness-protocol',
    title: 'Harness protocol (arena.yaml)',
    description: 'Declare how your harness installs and which files enter a battle workspace.',
    file: 'docs/HARNESS-PROTOCOL.md',
  },
  {
    slug: 'adapters',
    title: 'Agent adapters',
    description: 'What each official CLI reports, and what it cannot report.',
    file: 'docs/ADAPTERS.md',
  },
  {
    slug: 'security',
    title: 'Security model',
    description: 'Trust boundaries, harness trust prompts, and what Arena never touches.',
    file: 'docs/SECURITY.md',
  },
  {
    slug: 'privacy',
    title: 'Privacy',
    description: 'Local-only by default, and exactly what an upload contains.',
    file: 'docs/PRIVACY.md',
  },
  {
    slug: 'contributing',
    title: 'Contributing',
    description: 'Develop, test and extend Arena.',
    file: 'docs/CONTRIBUTING.md',
  },
];

export const DOCS_DIR = 'docs';

export function docHref(page: DocPage): string {
  return page.slug ? `/docs/${page.slug}` : '/docs';
}

/** Resolve a URL slug array to a registry entry. Unknown slugs (including traversal) return null. */
export function findDocPage(slug?: readonly string[] | string): DocPage | null {
  const key = Array.isArray(slug) ? slug.join('/') : typeof slug === 'string' ? slug : '';
  if (key.length > 100) return null;
  return DOC_PAGES.find((page) => page.slug === key) ?? null;
}

export function docNeighbours(page: DocPage): { prev: DocPage | null; next: DocPage | null } {
  const index = DOC_PAGES.findIndex((p) => p.slug === page.slug);
  return {
    prev: index > 0 ? (DOC_PAGES[index - 1] as DocPage) : null,
    next: index >= 0 && index < DOC_PAGES.length - 1 ? (DOC_PAGES[index + 1] as DocPage) : null,
  };
}

/** Walk up from a starting directory to the workspace root (the directory holding pnpm-workspace.yaml). */
export function findRepoRoot(from: string = process.cwd()): string | null {
  let dir = path.resolve(from);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Absolute path of a doc file, or null when the entry is not a .md file inside the docs directory.
 * Defence in depth: DOC_PAGES is already a whitelist, this re-checks the resolved path.
 */
export function safeDocFilePath(root: string, file: string): string | null {
  if (!file.endsWith('.md')) return null;
  if (file.includes('\0')) return null;
  const docsDir = path.resolve(root, DOCS_DIR);
  const resolved = path.resolve(root, file);
  const relative = path.relative(docsDir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

export interface LoadedDoc {
  page: DocPage;
  /** null when the file has not been written yet; the page renders a friendly notice */
  markdown: string | null;
  prev: DocPage | null;
  next: DocPage | null;
}

/** Read a doc page. Returns null only for an unknown slug; a missing file is a valid, empty page. */
export async function loadDocPage(slug?: readonly string[] | string): Promise<LoadedDoc | null> {
  const page = findDocPage(slug);
  if (!page) return null;
  return { page, markdown: await readDocFile(page), ...docNeighbours(page) };
}

export async function readDocFile(page: DocPage): Promise<string | null> {
  const root = findRepoRoot();
  if (!root) return null;
  const file = safeDocFilePath(root, page.file);
  if (!file) return null;
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** GitHub-style heading anchor. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

/** Extract the h2/h3 headings of a markdown document for an on-page outline. */
export function extractHeadings(markdown: string): Array<{ depth: 2 | 3; text: string; id: string }> {
  const out: Array<{ depth: 2 | 3; text: string; id: string }> = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(##|###)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const text = (match[2] as string).replace(/[*`]/g, '');
    out.push({ depth: match[1] === '##' ? 2 : 3, text, id: slugifyHeading(text) });
  }
  return out;
}
