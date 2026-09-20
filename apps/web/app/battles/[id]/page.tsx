import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Download, Terminal } from 'lucide-react';
import type { BattleStatus } from '@harness-arena/protocol';
import { getBattleForViewer, harnessSlug } from '@harness-arena/database';
import { BattleReport } from '@/components/battle/BattleReport';
import { IntegrityPanel } from '@/components/battle/IntegrityPanel';
import { ShareBlock } from '@/components/battle/ShareBlock';
import { BattleStatusBadge } from '@/components/battles/BattleList';
import { CopyLinkButton } from '@/components/battles/CopyLinkButton';
import { LiveBattle } from '@/components/battles/LiveBattle';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { getCurrentUser } from '@/lib/auth';
import { MAX_PAGE_EVENTS, loadEvents } from '@/lib/battles';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { absoluteUrl } from '@/lib/env';
import { battleLinks } from '@/lib/links';
import { updateVisibilityAction } from './actions';

export const dynamic = 'force-dynamic';

/** Statuses worth holding a stream open for. A pending battle has nothing to stream yet. */
const LIVE_STATUSES: ReadonlySet<BattleStatus> = new Set<BattleStatus>([
  'preparing',
  'running',
  'evaluating',
]);

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const dbh = await db();
  // metadata is public-only on purpose: a private battle must not leak its title to a crawler
  const found = await getBattleForViewer(dbh, id, null);
  if (!found || found.battle.visibility !== 'public') {
    return { title: 'Battle', robots: { index: false, follow: false } };
  }
  const record = found.battle.record;
  const a = record.runs.a;
  const b = record.runs.b;
  const title = record.task.title;
  const description = `${a.harness.name} (${a.agent.id}) vs ${b.harness.name} (${b.agent.id}) on one task at one commit.`;
  const ogImage = `/battles/${id}/opengraph-image?v=1`;
  return {
    title,
    description,
    alternates: { canonical: `/battles/${id}` },
    openGraph: {
      title,
      description,
      url: `/battles/${id}`,
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  };
}

export default async function BattlePage({ params }: PageProps) {
  const { id } = await params;
  const dbh = await db();
  const user = await getCurrentUser();
  const found = await getBattleForViewer(dbh, id, user?.id ?? null);
  if (!found) notFound();

  const record = found.battle.record;
  const loaded = await loadEvents(dbh, id, { cap: MAX_PAGE_EVENTS });
  const isOwner = Boolean(user && found.battle.ownerUserId === user.id);
  const live = LIVE_STATUSES.has(record.status);
  const links = battleLinks(id);
  const winner = record.verdict?.winner;
  const winnerSlug = winner === 'a' || winner === 'b' ? harnessSlug(record.runs[winner].harness) : null;

  return (
    <Container className="py-8" size="wide">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <BattleStatusBadge status={record.status} />
          <Badge variant="outline">{found.battle.visibility}</Badge>
          {record.demo ? <Badge variant="demo">Demo data</Badge> : null}
          <span className="font-mono text-2xs text-fg-subtle">{id}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyLinkButton url={links.url} />
          <a
            href={`/api/v1/battles/${id}?format=json`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 text-xs font-medium text-fg hover:bg-bg-subtle"
          >
            <Download size={13} aria-hidden="true" />
            battle.json
          </a>
        </div>
      </div>

      {isOwner ? (
        <Card className="mt-3">
          <CardHeader>
            <CardTitle>Owner controls</CardTitle>
            <span className="text-2xs text-fg-subtle">Only you can see a private battle.</span>
          </CardHeader>
          <CardBody>
            <form action={updateVisibilityAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="battleId" value={id} />
              <label htmlFor="visibility" className="text-xs font-medium text-fg-muted">
                Visibility
              </label>
              <select
                id="visibility"
                name="visibility"
                defaultValue={found.battle.visibility}
                className="h-8 rounded-md border border-border-strong bg-surface px-2 text-xs"
              >
                <option value="private">private (only you)</option>
                <option value="unlisted">unlisted (anyone with the link)</option>
                <option value="public">public (listed and in ratings)</option>
              </select>
              <button
                type="submit"
                className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg hover:bg-accent-hover"
              >
                Save
              </button>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {record.status === 'pending' ? (
        <Card className="mt-3">
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-1.5">
                <Terminal size={14} aria-hidden="true" />
                This battle runs on your machine
              </span>
            </CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <p className="text-[0.8125rem] text-fg-muted">
              Arena never pays for model usage. Run the spec with your own authenticated CLIs and the report
              fills in here as events arrive.
            </p>
            <CodeBlock terminal code={`${BRAND.cli.bin} login\n${BRAND.cli.bin} run --battle ${id}`} />
          </CardBody>
        </Card>
      ) : null}

      <div className="mt-4">
        {live ? (
          <LiveBattle
            initialRecord={record}
            initialEvents={loaded.events}
            streamUrl={absoluteUrl(`/api/v1/battles/${id}/stream`)}
          />
        ) : (
          <BattleReport record={record} events={loaded.events} />
        )}
      </div>

      <div className="mt-4">
        <IntegrityPanel record={record} />
      </div>

      {found.battle.visibility === 'public' ? (
        <div className="mt-4">
          <ShareBlock record={record} winnerSlug={winnerSlug} />
        </div>
      ) : null}

      {loaded.capped || loaded.invalid > 0 ? (
        <p className="mt-3 text-2xs text-fg-subtle">
          Rendered {loaded.events.length} events
          {loaded.capped ? ` (capped at ${MAX_PAGE_EVENTS}; download battle.json for the rest)` : ''}
          {loaded.invalid > 0 ? `, ${loaded.invalid} stored rows failed protocol validation` : ''}.
        </p>
      ) : null}
    </Container>
  );
}
