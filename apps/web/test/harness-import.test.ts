import './setup-env';
import { describe, expect, it } from 'vitest';
import type { FetchImpl } from '@harness-arena/harness';
import { getHarnessBySlug, getLineage, listHarnesses } from '@harness-arena/database';
import { inspectGithubHarness, saveHarness } from '@/lib/harness-import';
import { makeUser, testDb } from './helpers';

/**
 * The import path with an injected fetch: no network, no clone, no execution. The stub answers the
 * three GitHub endpoints the inspection uses and 404s everything else, exactly like a repository that
 * has no arena.yaml.
 */
const TREE = [
  { path: 'CLAUDE.md', type: 'blob' },
  { path: '.claude/skills/x/SKILL.md', type: 'blob' },
  { path: '.claude/settings.json', type: 'blob' },
  { path: 'package.json', type: 'blob' },
  { path: 'pnpm-lock.yaml', type: 'blob' },
  { path: 'docs', type: 'tree' },
];

const COMMIT_SHA = '9f1c0de4b6a7c8d9e0f1a2b3c4d5e6f708192a3b';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface StubOptions {
  repoStatus?: number;
  settings?: string;
  /** merged into the GET /repos/{owner}/{repo} body, e.g. fork metadata */
  repoBody?: Record<string, unknown>;
}

function githubStub(opts: StubOptions = {}): { fetchImpl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    const target = String(input);
    calls.push(target);
    if (/\/repos\/[^/]+\/[^/]+$/.test(target)) {
      if (opts.repoStatus && opts.repoStatus !== 200) return json({ message: 'Not Found' }, opts.repoStatus);
      return json({ default_branch: 'main', ...(opts.repoBody ?? {}) });
    }
    if (target.includes('/git/trees/')) return json({ tree: TREE, truncated: false });
    if (target.includes('/commits/')) return json({ sha: COMMIT_SHA });
    if (target.includes('/contents/.claude/settings.json')) {
      return new Response(opts.settings ?? '{"hooks":{"PreToolUse":[]}}', { status: 200 });
    }
    return json({ message: 'Not Found' }, 404);
  };
  return { fetchImpl, calls };
}

describe('harness import', () => {
  it('detects Claude Code features over the GitHub API', async () => {
    const { fetchImpl, calls } = githubStub();
    const result = await inspectGithubHarness({
      url: 'https://github.com/owner/my-harness',
      fetchImpl,
      token: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('my-harness');
    expect(result.ref).toBe('main');
    expect(result.slug).toBe('owner--my-harness');

    const inspection = result.inspection;
    expect(inspection.framework).toBe('claude-code');
    expect(inspection.commit).toBe(COMMIT_SHA);
    expect(inspection.fileCount).toBe(5); // blobs only; the tree entry is not a file

    const byId = new Map(inspection.features.map((feature) => [feature.id, feature]));
    expect(byId.get('claude_md')?.detected).toBe(true);
    expect(byId.get('claude_md')?.paths).toEqual(['CLAUDE.md']);
    expect(byId.get('claude_skills')?.detected).toBe(true);
    expect(byId.get('claude_skills')?.count).toBe(1);
    expect(byId.get('claude_hooks')?.detected).toBe(true);
    expect(byId.get('claude_settings')?.detected).toBe(true);
    expect(byId.get('arena_manifest')?.detected).toBe(false);
    expect(byId.get('gemini_md')?.detected).toBe(false);

    expect(inspection.manifest.found).toBe(false);
    expect(inspection.install.packageManager).toBe('pnpm');
    expect(inspection.install.commands).toEqual([]);
    expect(inspection.applyFiles).toContain('CLAUDE.md');
    expect(['ready', 'partial']).toContain(inspection.compatibility.status);

    // nothing was cloned and nothing was executed: only GitHub reads happened
    expect(calls.every((call) => call.startsWith('https://api.github.com/'))).toBe(true);
  });

  it('saves the harness and converges on a second import', async () => {
    const dbh = await testDb();
    const user = await makeUser('harness-importer', 9501);
    const { fetchImpl } = githubStub();
    const result = await inspectGithubHarness({ url: 'https://github.com/owner/saved', fetchImpl });
    if (!result.ok) throw new Error(result.message);

    const first = await saveHarness(dbh, {
      inspection: result.inspection,
      url: result.url,
      name: `${result.owner}/${result.repo}`,
      ownerUserId: user.id,
    });
    expect(first.slug).toBe('owner--saved');
    expect(first.created).toBe(true);

    const stored = await getHarnessBySlug(dbh, 'owner--saved');
    expect(stored?.framework).toBe('claude-code');
    expect(stored?.ownerUserId).toBe(user.id);
    expect(stored?.sourceUrl).toBe('https://github.com/owner/saved');

    const second = await saveHarness(dbh, {
      inspection: result.inspection,
      url: result.url,
      name: `${result.owner}/${result.repo}`,
      ownerUserId: user.id,
    });
    expect(second.created).toBe(false);
    expect(second.harnessId).toBe(first.harnessId);

    const all = await listHarnesses(dbh, { limit: 50 });
    expect(all.filter((harness) => harness.slug === 'owner--saved')).toHaveLength(1);
  });

  it('never transfers an owned harness to a later importer', async () => {
    const dbh = await testDb();
    const first = await makeUser('harness-owner-first', 9502);
    const second = await makeUser('harness-owner-second', 9503);
    const { fetchImpl } = githubStub();

    const contested = await inspectGithubHarness({ url: 'https://github.com/owner/contested', fetchImpl });
    if (!contested.ok) throw new Error(contested.message);
    const owned = {
      inspection: contested.inspection,
      url: contested.url,
      name: `${contested.owner}/${contested.repo}`,
    };
    await saveHarness(dbh, { ...owned, ownerUserId: first.id });
    await saveHarness(dbh, { ...owned, ownerUserId: second.id });
    expect((await getHarnessBySlug(dbh, 'owner--contested'))?.ownerUserId).toBe(first.id);

    // a row with no owner (one a battle upload discovered) is still claimable by an importer
    const unclaimed = await inspectGithubHarness({ url: 'https://github.com/owner/unclaimed', fetchImpl });
    if (!unclaimed.ok) throw new Error(unclaimed.message);
    const unowned = {
      inspection: unclaimed.inspection,
      url: unclaimed.url,
      name: `${unclaimed.owner}/${unclaimed.repo}`,
    };
    await saveHarness(dbh, { ...unowned, ownerUserId: null });
    await saveHarness(dbh, { ...unowned, ownerUserId: second.id });
    expect((await getHarnessBySlug(dbh, 'owner--unclaimed'))?.ownerUserId).toBe(second.id);
  });

  it('records one github_fork edge when GitHub says the repository is a fork', async () => {
    const dbh = await testDb();
    const { fetchImpl } = githubStub({
      repoBody: { fork: true, parent: { html_url: 'https://github.com/acme/upstream' } },
    });

    // the parent is catalogued first, so the edge resolves to a row rather than staying a bare URL
    const upstream = await inspectGithubHarness({ url: 'https://github.com/acme/upstream', fetchImpl });
    if (!upstream.ok) throw new Error(upstream.message);
    await saveHarness(dbh, {
      inspection: upstream.inspection,
      url: upstream.url,
      name: 'acme/upstream',
    });

    const child = await inspectGithubHarness({ url: 'https://github.com/owner/forked', fetchImpl });
    if (!child.ok) throw new Error(child.message);
    expect(child.repository).toEqual({
      fork: true,
      parent: { html_url: 'https://github.com/acme/upstream' },
    });

    const saved = await saveHarness(dbh, {
      inspection: child.inspection,
      url: child.url,
      name: `${child.owner}/${child.repo}`,
      githubRepo: child.repository,
    });
    expect(saved.lineageEdges).toBe(1);

    const lineage = await getLineage(dbh, 'owner--forked');
    expect(lineage?.ancestors).toHaveLength(1);
    expect(lineage?.ancestors[0]?.relation).toBe('forked_from');
    expect(lineage?.ancestors[0]?.evidence).toBe('github_fork');
    expect(lineage?.ancestors[0]?.parentSlug).toBe('acme--upstream');
    expect(lineage?.ancestors[0]?.parentSource).toBe('https://github.com/acme/upstream');

    // and the upstream sees it coming the other way
    const upstreamLineage = await getLineage(dbh, 'acme--upstream');
    expect(upstreamLineage?.descendants.map((edge) => edge.harnessSlug)).toEqual(['owner--forked']);
  });

  it('records no lineage for a repository GitHub does not call a fork', async () => {
    const dbh = await testDb();
    const { fetchImpl } = githubStub();
    const result = await inspectGithubHarness({ url: 'https://github.com/owner/original', fetchImpl });
    if (!result.ok) throw new Error(result.message);
    expect(result.repository).toEqual({ fork: false, parent: null });

    const saved = await saveHarness(dbh, {
      inspection: result.inspection,
      url: result.url,
      name: `${result.owner}/${result.repo}`,
      githubRepo: result.repository,
    });
    expect(saved.lineageEdges).toBe(0);
    expect((await getLineage(dbh, 'owner--original'))?.ancestors).toEqual([]);
  });

  it('explains a bad URL and a missing repository without leaking internals', async () => {
    const notGithub = await inspectGithubHarness({ url: 'https://gitlab.com/owner/repo' });
    expect(notGithub.ok).toBe(false);
    if (notGithub.ok) throw new Error('expected a failure');
    expect(notGithub.code).toBe('invalid_url');

    const { fetchImpl } = githubStub({ repoStatus: 404 });
    const missing = await inspectGithubHarness({ url: 'https://github.com/owner/private', fetchImpl });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected a failure');
    expect(missing.code).toBe('not_found');
    expect(missing.message).toContain('GITHUB_INSPECT_TOKEN');
  });
});
