import type { Metadata } from 'next';
import Link from 'next/link';
import { listBattles, listHarnesses } from '@harness-arena/database';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { db } from '@/lib/db';
import { relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Harnesses',
  description:
    'Every harness Arena has seen: imported from GitHub or discovered from a battle, with the agent framework it targets and how many public battles it has.',
  alternates: { canonical: '/harnesses' },
};

export default async function HarnessesPage() {
  const dbh = await db();
  const [harnesses, feed] = await Promise.all([
    listHarnesses(dbh, { limit: 100 }),
    listBattles(dbh, { limit: 100 }),
  ]);

  // battle counts come from the public feed, so the number never implies visibility a viewer lacks
  const counts = new Map<string, number>();
  for (const battle of feed.items) {
    for (const slug of [battle.a.harness, battle.b.harness]) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }

  return (
    <Container className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHeading
          eyebrow="harnesses"
          title="Harnesses"
          description="A harness is whatever you put in front of an agent CLI: instructions, skills, hooks, MCP servers, subagents, commands. Arena reads one over the GitHub API and never executes it."
        />
        <Button href="/harnesses/import" size="sm">
          Import a harness
        </Button>
      </div>

      <div className="mt-6">
        {harnesses.length === 0 ? (
          <div className="rounded-card border border-border bg-surface px-4 py-5">
            <h2 className="text-sm font-semibold">No harnesses yet</h2>
            <p className="mt-1 max-w-2xl text-[0.8125rem] text-fg-muted">
              Import one from a GitHub URL, or run a battle: every harness that appears in a battle is added
              to this catalog automatically.
            </p>
          </div>
        ) : (
          <TableWrap>
            <Table caption="Harnesses known to Arena">
              <THead>
                <TR>
                  <TH>Harness</TH>
                  <TH>Framework</TH>
                  <TH>Source</TH>
                  <TH className="text-right">Public battles</TH>
                  <TH>Updated</TH>
                </TR>
              </THead>
              <TBody>
                {harnesses.map((harness) => (
                  <TR key={harness.id}>
                    <TD>
                      <Link href={`/harnesses/${harness.slug}`} className="font-medium hover:text-accent">
                        {harness.name}
                      </Link>
                      {harness.description ? (
                        <span className="mt-0.5 block max-w-md truncate text-2xs text-fg-subtle">
                          {harness.description}
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      <Badge variant="outline">{harness.framework}</Badge>
                    </TD>
                    <TD>
                      {harness.sourceUrl ? (
                        <a
                          href={harness.sourceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="font-mono text-2xs text-accent hover:underline"
                        >
                          {harness.sourceUrl.replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        <span className="font-mono text-2xs text-fg-subtle">{harness.sourceKind}</span>
                      )}
                    </TD>
                    <TD mono className="text-right">
                      {counts.get(harness.slug) ?? 0}
                    </TD>
                    <TD>{relativeTime(harness.updatedAt.toISOString())}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>
    </Container>
  );
}
