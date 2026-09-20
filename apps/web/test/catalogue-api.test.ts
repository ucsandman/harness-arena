import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ComponentDetail, ComponentSummary, LineageEdge } from '@harness-arena/protocol';
import { makeId } from '@harness-arena/protocol';
import {
  harnessVersions,
  harnesses,
  recordLineage,
  upsertComponentsFromManifest,
} from '@harness-arena/database';
import { GET as listComponents } from '@/app/api/v1/components/route';
import { GET as readComponent } from '@/app/api/v1/components/[...slug]/route';
import { GET as readLineage } from '@/app/api/v1/harnesses/[slug]/lineage/route';
import { resetRateLimits } from '@/lib/api';
import { getRequest, jsonOf, params, testDb } from './helpers';

/**
 * The two read-only catalogue routes: a harness's ancestry and the component catalogue. Both are
 * public, both are pure projections of what a manifest or GitHub declared, and neither of them runs
 * anything. The component route is a catch-all because a component slug contains a slash.
 */

/** The catch-all route's own params shape; the shared `params` helper only types string values. */
function catchAll(...slug: string[]): { params: Promise<{ slug: string[] }> } {
  return { params: Promise.resolve({ slug }) };
}

const PARENT = 'lineage-api--parent';
const CHILD = 'lineage-api--child';

beforeAll(async () => {
  resetRateLimits();
  const dbh = await testDb();

  const ids: Record<string, string> = {};
  for (const slug of [PARENT, CHILD]) {
    const id = makeId('harness');
    ids[slug] = id;
    await dbh
      .insert(harnesses)
      .values({
        id,
        slug,
        name: slug,
        sourceKind: 'github',
        sourceUrl: `https://github.com/lineage-api/${slug}`,
        framework: 'claude-code',
      })
      .onConflictDoNothing({ target: harnesses.slug });
  }

  await recordLineage(dbh, ids[CHILD] as string, [
    {
      relation: 'forked_from',
      parentSource: `https://github.com/lineage-api/${PARENT}`,
      evidence: 'github_fork',
    },
  ]);

  const versionId = makeId('harnessVersion');
  await dbh.insert(harnessVersions).values({
    id: versionId,
    harnessId: ids[CHILD] as string,
    commit: 'c0ffee1234567890c0ffee1234567890c0ffee12',
    manifest: null,
    inspection: null,
  });
  await upsertComponentsFromManifest(dbh, versionId, {
    arena: 1,
    name: 'catalogue-api-harness',
    components: [
      {
        kind: 'skill',
        name: 'catalogue-api-skill',
        path: '.claude/skills/catalogue/SKILL.md',
        description: 'A skill the catalogue test declares.',
      },
    ],
  });
});

describe('lineage API', () => {
  it('returns the child ancestry, the parent descendants and the evidence note', async () => {
    const child = await readLineage(
      getRequest(`/api/v1/harnesses/${CHILD}/lineage`),
      params({ slug: CHILD }),
    );
    expect(child.status).toBe(200);
    const childBody = await jsonOf<{
      harnessSlug: string;
      ancestors: LineageEdge[];
      descendants: LineageEdge[];
      evidenceNote: string;
    }>(child);
    expect(childBody.harnessSlug).toBe(CHILD);
    expect(childBody.ancestors).toHaveLength(1);
    expect(childBody.ancestors[0]?.relation).toBe('forked_from');
    expect(childBody.ancestors[0]?.evidence).toBe('github_fork');
    expect(childBody.ancestors[0]?.parentSlug).toBe(PARENT);
    expect(childBody.descendants).toHaveLength(0);
    // the honesty rule is on the payload, not only in the docs
    expect(childBody.evidenceNote).toContain('never infers');

    const parent = await readLineage(
      getRequest(`/api/v1/harnesses/${PARENT}/lineage`),
      params({ slug: PARENT }),
    );
    const parentBody = await jsonOf<{ descendants: LineageEdge[] }>(parent);
    expect(parentBody.descendants.map((edge) => edge.harnessSlug)).toEqual([CHILD]);
  });

  it('404s a harness nobody has catalogued', async () => {
    const missing = await readLineage(
      getRequest('/api/v1/harnesses/nobody--here/lineage'),
      params({ slug: 'nobody--here' }),
    );
    expect(missing.status).toBe(404);
  });
});

describe('components API', () => {
  it('lists components with null evidence when no experiment has measured them', async () => {
    const listed = await listComponents(getRequest('/api/v1/components?kind=skill'));
    expect(listed.status).toBe(200);
    const body = await jsonOf<{ components: ComponentSummary[]; count: number }>(listed);
    const found = body.components.find((component) => component.slug === 'skill/catalogue-api-skill');
    expect(found).toBeDefined();
    expect(found?.kind).toBe('skill');
    expect(found?.harnesses).toBe(1);
    // nobody has run an experiment on it: null, never a zero that would read as "made no difference"
    expect(found?.evidence.experiments).toBe(0);
    expect(found?.evidence.summarized).toBe(0);
    expect(found?.evidence.correctnessDeltaPoints).toBeNull();
    expect(found?.evidence.tokenDeltaPercent).toBeNull();
  });

  it('refuses an unknown kind instead of ignoring it', async () => {
    const bad = await listComponents(getRequest('/api/v1/components?kind=nonsense'));
    expect(bad.status).toBe(400);
  });

  it('reads one component through the slash in its slug', async () => {
    const one = await readComponent(
      getRequest('/api/v1/components/skill/catalogue-api-skill'),
      catchAll('skill', 'catalogue-api-skill'),
    );
    expect(one.status).toBe(200);
    const body = await jsonOf<{ component: ComponentDetail }>(one);
    expect(body.component.slug).toBe('skill/catalogue-api-skill');
    expect(body.component.harnessList.map((entry) => entry.slug)).toEqual([CHILD]);
    expect(body.component.harnessList[0]?.path).toBe('.claude/skills/catalogue/SKILL.md');
    expect(body.component.experimentList).toEqual([]);

    const missing = await readComponent(
      getRequest('/api/v1/components/skill/not-a-real-one'),
      catchAll('skill', 'not-a-real-one'),
    );
    expect(missing.status).toBe(404);
  });
});
