import type { Metadata } from 'next';
import Link from 'next/link';
import { InspectionCard } from '@/components/harness/InspectionCard';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { getCurrentUser } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { inspectToken } from '@/lib/env';
import { inspectGithubHarness } from '@/lib/harness-import';
import { saveHarnessAction } from './actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Import a harness',
  description:
    'Paste a GitHub URL and Arena reads the repository over the API: CLAUDE.md, skills, hooks, MCP, subagents, commands and arena.yaml. Nothing is cloned and nothing is executed.',
  alternates: { canonical: '/harnesses/import' },
};

interface PageProps {
  searchParams: Promise<{ url?: string; error?: string }>;
}

const INPUT =
  'h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle';

export default async function ImportHarnessPage({ searchParams }: PageProps) {
  const { url: rawUrl, error } = await searchParams;
  const url = (rawUrl ?? '').trim();
  const user = await getCurrentUser();
  const result = url.length > 0 ? await inspectGithubHarness({ url, token: inspectToken() }) : null;
  const message = result && !result.ok ? result.message : error ? 'That import did not complete.' : null;

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="harness import"
        title="Import a harness from GitHub"
        description="Arena reads the repository through the GitHub REST API: a file listing plus a handful of small reads. It never clones the repository and never executes a line of it."
      />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Repository URL</CardTitle>
          <span className="text-2xs text-fg-subtle">
            Public repositories, or private with a server token.
          </span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <form method="get" action="/harnesses/import" className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="url" className="sr-only">
              GitHub repository URL
            </label>
            <input
              id="url"
              name="url"
              defaultValue={url}
              placeholder="https://github.com/owner/my-claude-harness"
              className={INPUT}
            />
            <button
              type="submit"
              className="h-10 shrink-0 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              Inspect
            </button>
          </form>
          {message ? (
            <p className="rounded-card border border-danger-border bg-danger-subtle px-3 py-2 text-[0.8125rem] text-danger">
              {message}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {result && result.ok ? (
        <div className="mt-4 flex flex-col gap-4">
          <InspectionCard
            inspection={result.inspection}
            title={`${result.owner}/${result.repo}`}
            sourceUrl={result.url}
          />

          <Card>
            <CardHeader>
              <CardTitle>Next</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              {user ? (
                <form action={saveHarnessAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="url" value={result.url} />
                  <button
                    type="submit"
                    className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
                  >
                    Save to Arena
                  </button>
                  <span className="text-2xs text-fg-subtle">
                    Adds it to the catalog with this inspection, so battles and ratings can point at it.
                  </span>
                </form>
              ) : (
                <p className="text-[0.8125rem] text-fg-muted">
                  <Link
                    href={`/login?next=${encodeURIComponent(`/harnesses/import?url=${result.url}`)}`}
                    className="text-accent hover:underline"
                  >
                    Sign in
                  </Link>{' '}
                  to save this harness to the catalog. You can battle it either way.
                </p>
              )}
              <div>
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                  Battle it from your machine
                </p>
                <CodeBlock
                  terminal
                  code={`${BRAND.cli.bin} battle --task "Fix the failing test" --a vanilla --b ${result.url}`}
                />
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {!result ? (
        <p className="mt-4 text-2xs text-fg-subtle">
          Looking for the format?{' '}
          <Link href="/docs/harness-protocol" className="text-accent hover:underline">
            arena.yaml
          </Link>{' '}
          is optional: a repository with CLAUDE.md, <span className="font-mono">.claude/</span>, AGENTS.md,
          GEMINI.md or an OpenCode config is detected as-is.
        </p>
      ) : null}
    </Container>
  );
}
