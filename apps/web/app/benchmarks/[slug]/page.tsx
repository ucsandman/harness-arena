import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { BenchmarkTask } from '@harness-arena/protocol';
import { getBenchmark } from '@harness-arena/database';
import { BattleLinks, EmptyPanel, categoryLabel } from '@/components/arena/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { benchmarkVersionResults } from '@/lib/benchmark-results';
import { getCurrentUser } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { formatUtcDate, shortCommit } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const dbh = await db();
  const found = await getBenchmark(dbh, slug);
  if (!found) return { title: 'Benchmark pack', robots: { index: false, follow: false } };
  return {
    title: `${found.benchmark.name} benchmark pack`,
    description:
      found.benchmark.description ??
      `${found.version.taskCount} tasks two harnesses can be run against, pinned to content hash ${found.version.id}.`,
    alternates: { canonical: `/benchmarks/${slug}` },
  };
}

/** What a task actually checks, in one line. An empty evaluation says so instead of implying gates. */
function evaluationSummary(task: BenchmarkTask | undefined): string {
  if (!task) return 'not recorded';
  const parts: string[] = [];
  if (task.evaluation.tests) parts.push(`tests: ${task.evaluation.tests.command}`);
  if (task.evaluation.build && task.evaluation.build.length > 0) {
    parts.push(`build: ${task.evaluation.build.join(' && ')}`);
  }
  if (task.evaluation.assertions.length > 0) parts.push(`${task.evaluation.assertions.length} assertion(s)`);
  return parts.length === 0 ? 'completion only (no tests, build or assertions)' : parts.join(' · ');
}

export default async function BenchmarkDetailPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { version: wantedVersion } = await searchParams;

  const dbh = await db();
  const user = await getCurrentUser();
  const found = await getBenchmark(dbh, slug, {
    viewerUserId: user?.id ?? null,
    ...(wantedVersion ? { versionId: wantedVersion } : {}),
  });
  if (!found) notFound();

  const { benchmark, version, pack, tasks, versions } = found;
  const packTasks = new Map(pack.tasks.map((task) => [task.id, task]));
  const results = await benchmarkVersionResults(dbh, version.id);

  const runCommand = `${BRAND.cli.bin} benchmark run ${benchmark.slug} --a <harness> --b vanilla --agent claude-code`;

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="benchmark pack"
        title={benchmark.name}
        description={
          benchmark.description ??
          'A versioned set of tasks. Which harnesses run it, with which agent, is decided at run time — that is what makes one pack version comparable across people.'
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge variant="accent" mono>
          {benchmark.slug}
        </Badge>
        <Badge variant="neutral" mono>
          v{version.version}
        </Badge>
        <Badge variant="outline" mono title="sha256 of the canonical pack content">
          {version.id}
        </Badge>
        <span className="text-2xs text-fg-subtle">
          {version.taskCount} task(s) · {version.battlesPerRun} battles per run ·{' '}
          {benchmark.author ?? 'unattributed'} · published {formatUtcDate(version.createdAt.toISOString())}
        </span>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Run it on your machine</CardTitle>
          <span className="text-2xs text-fg-subtle">Arena hosts no runner</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          <CodeBlock terminal code={runCommand} />
          <p className="text-2xs text-fg-subtle">
            Replace <span className="font-mono">&lt;harness&gt;</span> with a GitHub URL or a local path. One
            full run produces {version.battlesPerRun} battle(s) against your own agent subscription; add{' '}
            <span className="font-mono">--upload metrics --visibility public</span> to publish the results.
          </p>
        </CardBody>
      </Card>

      <h2 className="mt-8 text-sm font-semibold">Versions</h2>
      <p className="mt-1 text-2xs text-fg-subtle">
        A version id is the sha256 of the pack content. Editing a prompt, an assertion or a commit makes a new
        version, so a stored result can never point at a definition that changed.
      </p>
      <div className="mt-3">
        <TableWrap>
          <Table caption={`Versions of ${benchmark.slug}`}>
            <THead>
              <TR>
                <TH>Label</TH>
                <TH>Content hash</TH>
                <TH className="text-right">Tasks</TH>
                <TH className="text-right">Battles per run</TH>
                <TH>Published</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {versions.map((entry) => (
                <TR key={entry.versionId}>
                  <TD mono>{entry.version}</TD>
                  <TD mono className="text-2xs">
                    {entry.versionId}
                  </TD>
                  <TD mono className="text-right">
                    {entry.taskCount}
                  </TD>
                  <TD mono className="text-right">
                    {entry.battlesPerRun}
                  </TD>
                  <TD>{formatUtcDate(entry.createdAt)}</TD>
                  <TD>
                    {entry.versionId === version.id ? (
                      <Badge variant="accent">shown</Badge>
                    ) : (
                      <Link
                        href={`/benchmarks/${benchmark.slug}?version=${entry.versionId}`}
                        className="text-2xs text-accent hover:underline"
                      >
                        show this version
                      </Link>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      </div>

      <h2 className="mt-8 text-sm font-semibold">Tasks in v{version.version}</h2>
      <div className="mt-3">
        <TableWrap>
          <Table caption={`Tasks of ${benchmark.slug} v${version.version}`}>
            <THead>
              <TR>
                <TH>Task</TH>
                <TH>Category</TH>
                <TH>Repository</TH>
                <TH className="text-right">Trials</TH>
                <TH>Evaluation</TH>
              </TR>
            </THead>
            <TBody>
              {tasks.map((task) => (
                <TR key={task.taskId}>
                  <TD>
                    <span className="font-mono text-2xs text-fg-subtle">{task.taskId}</span>
                    <span className="block text-[0.8125rem] font-medium">{task.title}</span>
                  </TD>
                  <TD>
                    <Badge variant="outline">{categoryLabel(task.category)}</Badge>
                  </TD>
                  <TD>
                    <span className="font-mono text-2xs">{task.repositorySource}</span>
                    <span className="block font-mono text-2xs text-fg-subtle">
                      {task.repositoryCommit ? shortCommit(task.repositoryCommit, 12) : 'no commit pinned'}
                    </span>
                  </TD>
                  <TD mono className="text-right">
                    {task.trials}
                  </TD>
                  <TD className="text-2xs text-fg-muted">{evaluationSummary(packTasks.get(task.taskId))}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      </div>

      <h2 className="mt-8 text-sm font-semibold">Community results for this version</h2>
      <p className="mt-1 max-w-3xl text-2xs text-fg-subtle">
        Public battles whose spec names {version.id}, grouped by task. Side A and side B are labels chosen by
        whoever ran each battle, so these counts describe those battles; they are not a ranking of harnesses.
        Demo battles never appear here.
      </p>
      <div className="mt-3">
        {results.byTask.length === 0 ? (
          <EmptyPanel
            title="No public battles have run this version yet"
            note="Results appear here when someone runs the pack and uploads the battles as public. Nothing is executed by Arena."
          />
        ) : (
          <TableWrap>
            <Table caption={`Battles run against ${benchmark.slug} ${version.id}`}>
              <THead>
                <TR>
                  <TH>Task</TH>
                  <TH className="text-right">Battles</TH>
                  <TH className="text-right">Decided</TH>
                  <TH className="text-right">Side A / Side B</TH>
                  <TH className="text-right">Ties</TH>
                  <TH className="text-right">Inconclusive</TH>
                  <TH>Recent</TH>
                </TR>
              </THead>
              <TBody>
                {results.byTask.map((entry) => (
                  <TR key={entry.taskId}>
                    <TD>
                      <span className="font-mono text-2xs">{entry.taskId}</span>
                      <span className="block text-2xs text-fg-subtle">
                        {packTasks.get(entry.taskId)?.title ?? 'not in this version'}
                      </span>
                    </TD>
                    <TD mono className="text-right">
                      {entry.battles}
                    </TD>
                    <TD mono className="text-right">
                      {entry.decided}
                    </TD>
                    <TD mono className="text-right">
                      {entry.sideAWins} / {entry.sideBWins}
                    </TD>
                    <TD mono className="text-right">
                      {entry.ties}
                    </TD>
                    <TD mono className="text-right">
                      {entry.inconclusive}
                    </TD>
                    <TD>
                      <BattleLinks ids={entry.recent.map((battle) => battle.id)} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>

      <p className="mt-4 text-2xs text-fg-subtle">
        {results.battles} public battle(s) read for this version
        {results.capped ? ', capped at the most recent 500' : ''}. A pack run is a sample, not a ranking: see{' '}
        <Link href="/docs/experiments" className="text-accent hover:underline">
          how many battles a claim needs
        </Link>
        .
      </p>
    </Container>
  );
}
