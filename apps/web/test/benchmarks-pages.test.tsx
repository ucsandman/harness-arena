import './setup-env';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { benchmarkPackSchema, benchmarkVersionId, type BenchmarkPack } from '@harness-arena/protocol';
import { publishBenchmark } from '@harness-arena/database';
import BenchmarksPage from '../app/benchmarks/page';
import BenchmarkDetailPage from '../app/benchmarks/[slug]/page';
import { makeUser, testDb } from './helpers';

const COMMIT = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';

function pack(): BenchmarkPack {
  return benchmarkPackSchema.parse({
    benchmark: 1,
    slug: 'web-test-pack',
    name: 'Web test pack',
    description: 'Two tasks, used by the page tests.',
    author: 'page-tester',
    version: '1.0.0',
    visibility: 'public',
    tasks: [
      {
        id: 'fix-null-deref',
        title: 'Fix the null dereference',
        category: 'debugging',
        trials: 2,
        task: { kind: 'prompt', prompt: 'Fix the crash on empty input.' },
        repository: { source: 'https://github.com/owner/repo', commit: COMMIT },
        evaluation: {
          tests: { command: 'npm test' },
          assertions: [{ type: 'file-exists', path: 'README.md' }],
        },
      },
      {
        id: 'add-docs',
        title: 'Document the parser',
        category: 'documentation',
        trials: 1,
        task: { kind: 'prompt', prompt: 'Write the parser docs.' },
        repository: { source: 'https://github.com/owner/repo', ref: 'main' },
      },
    ],
  });
}

async function publish(): Promise<{ versionId: string }> {
  const dbh = await testDb();
  const user = await makeUser('benchmark-publisher', 9801);
  const parsed = pack();
  const versionId = await benchmarkVersionId(parsed);
  await publishBenchmark(dbh, parsed, { ownerUserId: user.id, versionId });
  return { versionId };
}

function list(query: { category?: string } = {}): Promise<string> {
  return Promise.resolve(BenchmarksPage({ searchParams: Promise.resolve(query) })).then(renderToStaticMarkup);
}

describe('/benchmarks', () => {
  it('lists a published pack with its task count and battles per run, and filters by category', async () => {
    await publish();

    const all = await list();
    expect(all).toContain('Web test pack');
    expect(all).toContain('web-test-pack');
    expect(all).toContain('1.0.0');
    // 2 tasks, trials 2 + 1 = 3 battles for one full run: the cost, stated before you start
    expect(all).toContain('>2</td>');
    expect(all).toContain('>3</td>');
    expect(all).toContain('page-tester');

    const debugging = await list({ category: 'debugging' });
    expect(debugging).toContain('Web test pack');

    const security = await list({ category: 'security' });
    expect(security).not.toContain('Web test pack');
    expect(security).toContain('No pack covers Security yet');
  });
});

describe('/benchmarks/[slug]', () => {
  it('shows the version hash, the tasks with their evaluation, the run command and an honest empty result set', async () => {
    const { versionId } = await publish();

    const html = renderToStaticMarkup(
      await BenchmarkDetailPage({
        params: Promise.resolve({ slug: 'web-test-pack' }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(versionId).toMatch(/^bmv_[0-9a-f]{24}$/);
    expect(html).toContain(versionId);
    expect(html).toContain('arena benchmark run web-test-pack');
    expect(html).toContain('fix-null-deref');
    expect(html).toContain('Fix the null dereference');
    expect(html).toContain('npm test');
    expect(html).toContain('1 assertion(s)');
    // the task with no tests, build or assertions says so instead of implying a gate
    expect(html).toContain('completion only (no tests, build or assertions)');
    expect(html).toContain('1a2b3c4d5e6f');
    expect(html).toContain('no commit pinned');
    expect(html).toContain('No public battles have run this version yet');
    expect(html).toContain('0 public battle(s) read for this version');
  });

  it('selects an explicit version with ?version=', async () => {
    const { versionId } = await publish();

    const html = renderToStaticMarkup(
      await BenchmarkDetailPage({
        params: Promise.resolve({ slug: 'web-test-pack' }),
        searchParams: Promise.resolve({ version: versionId }),
      }),
    );
    expect(html).toContain(versionId);
    expect(html).toContain('shown');
  });
});
