import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BenchmarkVersionSummary } from '@harness-arena/protocol';
import { GET as listBenchmarks, POST as publishBenchmark } from '@/app/api/v1/benchmarks/route';
import { GET as getBenchmark } from '@/app/api/v1/benchmarks/[slug]/route';
import { resetRateLimits } from '@/lib/api';
import { getRequest, jsonRequest, makeDevice, params } from './helpers';

/** A minimal valid pack, given a unique slug so tests never collide with each other. */
function testPack(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    benchmark: 1,
    slug,
    name: 'Test pack ' + slug,
    version: '1.0.0',
    tasks: [
      {
        id: 'one',
        title: 'One',
        category: 'debugging',
        task: { kind: 'prompt', prompt: 'do it' },
        repository: { source: 'empty' },
      },
    ],
    ...overrides,
  };
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('benchmarks API', () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it('publishes a pack, converges on re-upload, and refuses a slug hijack', async () => {
    const owner = await makeDevice('benchmark-owner', 9301);
    const slug = uniqueSlug('test-pack');
    const pack = testPack(slug);

    const created = await publishBenchmark(
      jsonRequest('/api/v1/benchmarks', { pack }, { token: owner.token }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.slug).toBe(slug);
    expect(createdBody.version).toBe('1.0.0');
    expect(createdBody.created).toBe(true);
    expect(createdBody.url).toBe(`http://localhost:3000/benchmarks/${slug}`);

    // re-publishing identical content is a no-op
    const republished = await publishBenchmark(
      jsonRequest('/api/v1/benchmarks', { pack }, { token: owner.token }),
    );
    expect(republished.status).toBe(200);
    const republishedBody = await republished.json();
    expect(republishedBody.created).toBe(false);
    expect(republishedBody.versionId).toBe(createdBody.versionId);

    // a second account cannot publish to the same slug
    const stranger = await makeDevice('benchmark-stranger', 9302);
    const hijack = await publishBenchmark(
      jsonRequest(
        '/api/v1/benchmarks',
        { pack: testPack(slug, { version: '2.0.0' }) },
        { token: stranger.token },
      ),
    );
    expect(hijack.status).toBe(403);

    // it shows up in the public list
    const list = await listBenchmarks(getRequest('/api/v1/benchmarks'));
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.benchmarks.some((entry: BenchmarkVersionSummary) => entry.slug === slug)).toBe(true);

    // and the pack, its tasks and its version history read back
    const detail = await getBenchmark(getRequest(`/api/v1/benchmarks/${slug}`), params({ slug }));
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.benchmark.slug).toBe(slug);
    expect(detailBody.pack.slug).toBe(slug);
    expect(detailBody.tasks).toHaveLength(1);
    expect(detailBody.tasks[0].taskId).toBe('one');
    expect(detailBody.versions).toHaveLength(1);
  });

  it('returns 404 for an unknown slug', async () => {
    const missing = await getBenchmark(
      getRequest('/api/v1/benchmarks/does-not-exist-xyz'),
      params({ slug: 'does-not-exist-xyz' }),
    );
    expect(missing.status).toBe(404);
    const body = await missing.json();
    expect(body.error.code).toBe('not_found');
  });

  it('keeps a private pack invisible to another account and visible to its owner', async () => {
    const owner = await makeDevice('benchmark-private-owner', 9303);
    const stranger = await makeDevice('benchmark-private-stranger', 9304);
    const slug = uniqueSlug('private-pack');
    const pack = testPack(slug, { visibility: 'private' });

    const created = await publishBenchmark(
      jsonRequest('/api/v1/benchmarks', { pack }, { token: owner.token }),
    );
    expect(created.status).toBe(201);

    const asStranger = await getBenchmark(
      getRequest(`/api/v1/benchmarks/${slug}`, { token: stranger.token }),
      params({ slug }),
    );
    expect(asStranger.status).toBe(404);

    const asOwner = await getBenchmark(
      getRequest(`/api/v1/benchmarks/${slug}`, { token: owner.token }),
      params({ slug }),
    );
    expect(asOwner.status).toBe(200);
    const body = await asOwner.json();
    expect(body.benchmark.slug).toBe(slug);
  });
});
