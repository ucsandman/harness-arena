import {
  createGitHubFileSource,
  GitHubSourceError,
  inspectHarness,
  parseGitHubUrl,
  type FetchImpl,
} from '@harness-arena/harness';
import type { HarnessInspection } from '@harness-arena/protocol';
import { makeId } from '@harness-arena/protocol';
import {
  getHarnessBySlug,
  harnessSlug,
  harnessVersions,
  harnesses,
  lineageFromGithub,
  lineageFromManifest,
  recordLineage,
  upsertComponentsFromManifest,
  type ArenaDatabase,
} from '@harness-arena/database';

/**
 * Harness import: read a GitHub repository through the REST API and report what Arena found. The web
 * server never clones a repository and never executes a line of it (docs/SECURITY.md); this module is
 * the only place that talks to GitHub, and the inspection token is never exposed to a client.
 */

export type ImportErrorCode = 'invalid_url' | 'not_found' | 'rate_limit' | 'auth' | 'network' | 'error';

/**
 * The two fields of the GitHub repository payload Arena reads for ancestry. A fork is the only
 * relationship Arena ever learns without someone declaring it, and it comes from GitHub, not from a
 * guess about file contents (docs/LINEAGE.md).
 */
export interface GithubRepoMeta {
  fork: boolean;
  parent: { html_url: string } | null;
}

export interface ImportSuccess {
  ok: true;
  inspection: HarnessInspection;
  /** fork metadata as GitHub reported it, or null when the repository could not be read */
  repository: GithubRepoMeta | null;
  owner: string;
  repo: string;
  url: string;
  ref: string;
  slug: string;
}

export interface ImportFailure {
  ok: false;
  code: ImportErrorCode;
  message: string;
}

export type ImportResult = ImportSuccess | ImportFailure;

export interface InspectInput {
  url: string;
  token?: string | null;
  fetchImpl?: FetchImpl;
  apiBase?: string;
}

const FRIENDLY: Record<ImportErrorCode, string> = {
  invalid_url:
    'That does not look like a public GitHub repository URL (for example https://github.com/owner/repo).',
  not_found: 'GitHub returned "not found". A private repository needs GITHUB_INSPECT_TOKEN on the server.',
  rate_limit: 'GitHub rate-limited this server. Try again shortly, or set GITHUB_INSPECT_TOKEN.',
  auth: 'GitHub refused the request. The configured inspection token is missing a scope or is invalid.',
  network: 'Could not reach the GitHub API.',
  error: 'Inspection failed.',
};

/** Best effort: the exact commit the inspection was taken at, so a saved version is pinned. */
async function resolveCommitSha(opts: {
  owner: string;
  repo: string;
  ref: string;
  token?: string | null;
  apiBase?: string;
  fetchImpl?: FetchImpl;
}): Promise<string | null> {
  const base = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'harness-arena',
    'x-github-api-version': '2022-11-28',
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  try {
    const res = await doFetch(
      `${base}/repos/${opts.owner}/${opts.repo}/commits/${encodeURIComponent(opts.ref)}`,
      { headers },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { sha?: unknown };
    return typeof body.sha === 'string' && body.sha.length > 0 ? body.sha : null;
  } catch {
    return null;
  }
}

/**
 * Fork metadata from `GET /repos/{owner}/{repo}`. Best effort: a repository Arena cannot read simply
 * has no fork edge, and an import is never failed over it. Only `fork` and `parent.html_url` are
 * kept; nothing else of the payload is stored.
 */
async function fetchRepoMeta(opts: {
  owner: string;
  repo: string;
  token?: string | null;
  apiBase?: string;
  fetchImpl?: FetchImpl;
}): Promise<GithubRepoMeta | null> {
  const base = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'harness-arena',
    'x-github-api-version': '2022-11-28',
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  try {
    const res = await doFetch(`${base}/repos/${opts.owner}/${opts.repo}`, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { fork?: unknown; parent?: { html_url?: unknown } | null };
    const parentUrl = body.parent?.html_url;
    return {
      fork: body.fork === true,
      parent: typeof parentUrl === 'string' && parentUrl.length > 0 ? { html_url: parentUrl } : null,
    };
  } catch {
    return null;
  }
}

export async function inspectGithubHarness(input: InspectInput): Promise<ImportResult> {
  const parts = parseGitHubUrl(input.url);
  if (!parts) return { ok: false, code: 'invalid_url', message: FRIENDLY.invalid_url };

  const files = createGitHubFileSource({
    owner: parts.owner,
    repo: parts.repo,
    ref: parts.ref,
    path: parts.path,
    token: input.token ?? null,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.apiBase ? { apiBase: input.apiBase } : {}),
  });

  try {
    const ref = await files.resolveRef();
    const commit = await resolveCommitSha({
      owner: parts.owner,
      repo: parts.repo,
      ref,
      token: input.token ?? null,
      ...(input.apiBase ? { apiBase: input.apiBase } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    const repository = await fetchRepoMeta({
      owner: parts.owner,
      repo: parts.repo,
      token: input.token ?? null,
      ...(input.apiBase ? { apiBase: input.apiBase } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    const inspection = await inspectHarness(
      { kind: 'github', url: parts.url, owner: parts.owner, repo: parts.repo, ref, path: parts.path },
      files,
      { commit },
    );
    return {
      ok: true,
      repository,
      inspection,
      owner: parts.owner,
      repo: parts.repo,
      url: parts.url,
      ref,
      slug: slugForInspection(inspection, parts.url, `${parts.owner}/${parts.repo}`),
    };
  } catch (err) {
    if (err instanceof GitHubSourceError) {
      const code: ImportErrorCode =
        err.kind === 'http' || err.kind === 'invalid_response' ? 'error' : err.kind;
      return { ok: false, code, message: `${FRIENDLY[code]} (${err.message})` };
    }
    return { ok: false, code: 'error', message: FRIENDLY.error };
  }
}

/** Same identity the battle pipeline derives, so an imported harness and a battled one are one row. */
export function slugForInspection(inspection: HarnessInspection, url: string, name: string): string {
  return harnessSlug({ kind: inspection.source.kind, source: url, name });
}

export interface SaveHarnessInput {
  inspection: HarnessInspection;
  url: string;
  name: string;
  ownerUserId?: string | null;
  /** from inspectGithubHarness; a fork here becomes one `github_fork` lineage edge (docs/LINEAGE.md) */
  githubRepo?: GithubRepoMeta | null;
}

export interface SavedHarness {
  slug: string;
  harnessId: string;
  created: boolean;
  /** ancestry edges written from GitHub fork metadata and from the manifest's own `lineage:` block */
  lineageEdges: number;
  /** components the manifest declares, attached to this version */
  components: number;
}

/**
 * Store the harness and one version carrying the inspection JSON. Converging on the slug, so importing
 * a harness that already appeared in a battle enriches that row instead of creating a second one.
 */
export async function saveHarness(db: ArenaDatabase, input: SaveHarnessInput): Promise<SavedHarness> {
  const slug = slugForInspection(input.inspection, input.url, input.name);
  const existing = await getHarnessBySlug(db, slug);
  const description = input.inspection.manifest.manifest?.description ?? null;
  const framework = input.inspection.framework;

  const [row] = await db
    .insert(harnesses)
    .values({
      id: makeId('harness'),
      slug,
      name: input.name,
      sourceKind: input.inspection.source.kind,
      sourceUrl: input.url,
      ownerUserId: input.ownerUserId ?? null,
      description,
      framework,
    })
    .onConflictDoUpdate({
      target: harnesses.slug,
      set: {
        name: input.name,
        sourceKind: input.inspection.source.kind,
        sourceUrl: input.url,
        description,
        framework,
        updatedAt: new Date(),
        // only an unowned row is claimed: a later importer never takes over someone else's harness
        ...(input.ownerUserId && !existing?.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      },
    })
    .returning({ id: harnesses.id });
  if (!row) throw new Error(`saveHarness: no harness row for ${slug}`);

  const [version] = await db
    .insert(harnessVersions)
    .values({
      id: makeId('harnessVersion'),
      harnessId: row.id,
      commit: input.inspection.commit,
      manifest: input.inspection.manifest.manifest,
      inspection: input.inspection,
    })
    .onConflictDoUpdate({
      target: [harnessVersions.harnessId, harnessVersions.commit],
      set: { manifest: input.inspection.manifest.manifest, inspection: input.inspection },
    })
    .returning({ id: harnessVersions.id });

  // Ancestry and components, from the two sources Arena accepts: GitHub's own fork flag, and the
  // harness's own arena.yaml. Nothing is inferred from file contents (docs/LINEAGE.md).
  const manifest = input.inspection.manifest.manifest;
  const lineageEdges = await recordLineage(db, row.id, [
    ...lineageFromGithub(input.githubRepo ?? { fork: false }),
    ...lineageFromManifest(manifest),
  ]);
  const components = version ? await upsertComponentsFromManifest(db, version.id, manifest) : 0;

  return { slug, harnessId: row.id, created: existing === null, lineageEdges, components };
}
