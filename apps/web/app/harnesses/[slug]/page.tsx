import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  BADGE_KINDS,
  BADGE_KIND_LABELS,
  RATING_CATEGORY_LABELS,
  RATING_MIN_SAMPLE,
  RATING_POOL_LABELS,
  type BadgeKind,
  type RatingCategory,
} from '@harness-arena/protocol';
import {
  getHarnessInsights,
  getHarnessProfile,
  getLineage,
  getRatingHistory,
  getUserById,
  listChallenges,
  listOpponents,
} from '@harness-arena/database';
import { BattleList } from '@/components/battles/BattleList';
import { InspectionCard } from '@/components/harness/InspectionCard';
import { FormGlyphs, GlickoFootnote, RatingValue, SampleBadge } from '@/components/ratings/RatingBits';
import { RatingChart } from '@/components/ratings/RatingChart';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { Stat } from '@/components/ui/Stat';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { webUrl } from '@/lib/env';
import { formatPercent, formatUtcDate, shortCommit } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ saved?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const dbh = await db();
  const profile = await getHarnessProfile(dbh, slug);
  if (!profile) return { title: 'Harness', robots: { index: false, follow: false } };
  const title = profile.harness.name;
  const description =
    profile.harness.description ??
    `${profile.harness.name}: ${/^[aeiou]/i.test(profile.harness.framework) ? 'an' : 'a'} ${profile.harness.framework} harness, with its ratings, per-category record, versions and public battles.`;
  const image = `/harnesses/${slug}/opengraph-image?v=1`;
  return {
    title,
    description,
    alternates: { canonical: `/harnesses/${slug}` },
    openGraph: {
      title,
      description,
      url: `/harnesses/${slug}`,
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

function categoryLabel(category: string): string {
  return RATING_CATEGORY_LABELS[category as RatingCategory] ?? category;
}

/** A ratio against the opponents, stated in the direction a reader cares about, always with its n. */
function efficiencyPhrase(median: number | null, n: number, noun: string): string {
  if (median === null || n === 0) return `n/a (0 battles)`;
  const delta = Math.round(Math.abs(median - 1) * 100);
  if (delta === 0) return `about the same ${noun} (${median.toFixed(2)}x, n=${n})`;
  return `${delta}% ${median < 1 ? 'fewer' : 'more'} ${noun} (${median.toFixed(2)}x, n=${n})`;
}

const EFFICIENCY_LABELS: Record<string, { label: string; noun: string }> = {
  tokens_total: { label: 'Tokens', noun: 'tokens' },
  cost_usd: { label: 'Cost', noun: 'cost' },
  duration_ms: { label: 'Wall time', noun: 'time' },
};

export default async function HarnessProfilePage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { saved } = await searchParams;
  const dbh = await db();
  const profile = await getHarnessProfile(dbh, slug);
  if (!profile) notFound();

  const { harness, versions, recentBattles, ratings, categoryPerformance, efficiencyProfile } = profile;
  const [owner, opponents, insightResult, lineage, challenges] = await Promise.all([
    harness.ownerUserId ? getUserById(dbh, harness.ownerUserId) : Promise.resolve(null),
    listOpponents(dbh, slug, 10),
    getHarnessInsights(dbh, slug),
    getLineage(dbh, slug),
    listChallenges(dbh, { harnessSlug: slug, limit: 20 }),
  ]);

  const latestInspection = versions.find((version) => version.inspection !== null)?.inspection ?? null;
  const latestManifest = versions.find((version) => version.manifest !== null)?.manifest ?? null;
  const supportedAgents = latestManifest?.agents ?? latestInspection?.agents ?? [];

  const community = ratings.filter((rating) => rating.pool === 'community');
  const verified = ratings.filter((rating) => rating.pool === 'verified');
  const communityOverall = community.filter((rating) => rating.category === 'overall');
  const verifiedOverall = verified.filter((rating) => rating.category === 'overall');

  // The curve is drawn for the agent this harness has the most community battles under; a profile
  // with two agents would otherwise silently pick one and present it as the harness's history.
  const primary = [...communityOverall].sort((a, b) => b.battles - a.battles)[0] ?? null;
  const history = primary
    ? await getRatingHistory(dbh, slug, {
        agentId: primary.agentId,
        category: 'overall',
        pool: 'community',
        limit: 200,
      })
    : [];

  const overallPerformance = categoryPerformance.find((entry) => entry.category === 'overall') ?? null;
  const topCategory =
    categoryPerformance.find((entry) => entry.category !== 'overall')?.category ?? 'overall';
  const origin = webUrl();

  function badgeUrl(kind: BadgeKind): string {
    const query = new URLSearchParams();
    if (primary) query.set('agent', primary.agentId);
    if (kind === 'top' || kind === 'correctness' || kind === 'battles') query.set('category', topCategory);
    const suffix = query.toString();
    return `/api/v1/badges/${slug}/${kind}${suffix ? `?${suffix}` : ''}`;
  }

  return (
    <Container className="py-10">
      {saved === '1' ? (
        <p className="mb-4 rounded-card border border-success-border bg-success-subtle px-4 py-2.5 text-[0.8125rem] text-success">
          Saved. This harness is now in the catalog with its inspection.
        </p>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{harness.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-fg-muted">
            <Badge variant="outline">{harness.framework}</Badge>
            <span className="font-mono">{harness.slug}</span>
            {harness.sourceUrl ? (
              <a
                href={harness.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent hover:underline"
              >
                {harness.sourceUrl.replace(/^https?:\/\//, '')}
              </a>
            ) : (
              <span className="font-mono">{harness.sourceKind}</span>
            )}
            {owner ? <span>imported by @{owner.login}</span> : <span>discovered from a battle</span>}
          </p>
          {harness.description ? (
            <p className="mt-2 max-w-2xl text-[0.9375rem] text-fg-muted">{harness.description}</p>
          ) : null}
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-fg-muted">
            <span className="uppercase tracking-wide text-fg-subtle">Agents</span>
            {supportedAgents.length === 0 ? (
              <span>not declared in a manifest and not detected</span>
            ) : (
              supportedAgents.map((agent) => (
                <Badge key={agent} variant="neutral" mono>
                  {agent}
                </Badge>
              ))
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button href={`/challenges/new?b=${encodeURIComponent(slug)}`} size="sm">
            Challenge this harness
          </Button>
          <Button href="/battles/new" size="sm" variant="secondary">
            Battle this harness
          </Button>
        </div>
      </div>

      {/* ---- ratings, per pool, never mixed ---- */}
      <section className="mt-6 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{RATING_POOL_LABELS.community} rating</CardTitle>
            <span className="text-2xs text-fg-subtle">Self-reported local battles</span>
          </CardHeader>
          {communityOverall.length === 0 ? (
            <CardBody className="text-[0.8125rem] text-fg-muted">
              No decided battles yet, so this harness has no community rating. A rating moves only on a public
              battle with a decided winner that passed the integrity checks.
            </CardBody>
          ) : (
            <CardBody className="flex flex-col gap-4">
              {communityOverall.map((rating) => (
                <div key={rating.agentId} className="flex flex-wrap items-end gap-6">
                  <Stat
                    label={`${rating.agentId} · overall`}
                    value={<RatingValue rating={rating.rating} deviation={rating.deviation} />}
                    hint={`peak ${Math.round(rating.peakRating)}`}
                  />
                  <Stat
                    label="Battles"
                    value={rating.battles}
                    hint={`W/L/T ${rating.wins}/${rating.losses}/${rating.ties}`}
                  />
                  <Stat
                    label="Win rate"
                    value={rating.battles === 0 ? 'n/a' : formatPercent(rating.wins / rating.battles)}
                    hint={`of ${rating.battles} decided`}
                  />
                  <div className="flex flex-col gap-1">
                    <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Form</span>
                    <FormGlyphs form={rating.form} />
                  </div>
                  <SampleBadge provisional={rating.provisional} battles={rating.battles} />
                </div>
              ))}
            </CardBody>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{RATING_POOL_LABELS.verified} rating</CardTitle>
            <Badge variant="unavailable">designed, not hosted</Badge>
          </CardHeader>
          <CardBody className="flex flex-col gap-2 text-[0.8125rem] text-fg-muted">
            {verifiedOverall.length === 0 ? (
              <p>
                <span className="font-semibold text-fg">None.</span> A verified battle is one Arena executed
                itself in a controlled sandbox; no hosted runner exists, so this pool is empty for every
                harness. Community results never feed it.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-6">
                {verifiedOverall.map((rating) => (
                  <Stat
                    key={rating.agentId}
                    label={`${rating.agentId} · overall`}
                    value={<RatingValue rating={rating.rating} deviation={rating.deviation} />}
                    hint={`${rating.battles} battles, peak ${Math.round(rating.peakRating)}`}
                  />
                ))}
              </div>
            )}
            <p className="text-2xs text-fg-subtle">
              Provisional below {RATING_MIN_SAMPLE} decided battles. See the{' '}
              <Link href="/leaderboard?pool=verified" className="text-accent hover:underline">
                verified pool
              </Link>{' '}
              for what it would guarantee.
            </p>
          </CardBody>
        </Card>
      </section>

      {/* ---- category record ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Category performance</CardTitle>
          <span className="text-2xs text-fg-subtle">
            {profile.analyzedBattles === 0
              ? 'No decided public battles yet'
              : `Over the ${profile.analyzedBattles} most recent decided public battles`}
          </span>
        </CardHeader>
        <div className="border-t border-border">
          {categoryPerformance.length === 0 ? (
            <p className="px-4 py-3 text-[0.8125rem] text-fg-muted">
              No decided public battles, so there is nothing to break down by category.
            </p>
          ) : (
            <TableWrap>
              <Table caption="Per-category record">
                <THead>
                  <TR>
                    <TH>Category</TH>
                    <TH className="text-right">Battles</TH>
                    <TH className="text-right">W / L / T</TH>
                    <TH className="text-right">Win rate</TH>
                    <TH className="text-right">Correctness</TH>
                  </TR>
                </THead>
                <TBody>
                  {categoryPerformance.map((entry) => (
                    <TR key={entry.category}>
                      <TD>{categoryLabel(entry.category)}</TD>
                      <TD mono className="text-right">
                        {entry.battles}
                      </TD>
                      <TD mono className="text-right">
                        {entry.wins} / {entry.losses} / {entry.ties}
                      </TD>
                      <TD mono className="text-right">
                        {entry.battles === 0 ? 'n/a' : formatPercent(entry.wins / entry.battles)}
                      </TD>
                      <TD mono className="text-right">
                        {entry.correctnessRate === null ? (
                          <span className="text-fg-subtle">n/a (0 rated gates)</span>
                        ) : (
                          <>
                            {formatPercent(entry.correctnessRate)}
                            <span className="text-fg-subtle"> · n={entry.correctnessBattles}</span>
                          </>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
          <p className="border-t border-border px-4 py-2.5 text-2xs text-fg-subtle">
            Correctness is the share of battles where this harness won or tied every correctness gate that
            actually ran (completion, tests, regressions, assertions, build). A category with no verdict
            breakdown has no rate, never a zero.
          </p>
        </div>
      </Card>

      {/* ---- efficiency ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Efficiency against its opponents</CardTitle>
          <span className="text-2xs text-fg-subtle">Median ratio, this harness / the other side</span>
        </CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {efficiencyProfile.map((entry) => {
            const meta = EFFICIENCY_LABELS[entry.metric] ?? { label: entry.metric, noun: entry.metric };
            return (
              <Stat
                key={entry.metric}
                label={meta.label}
                value={entry.median === null || entry.n === 0 ? 'n/a' : `${entry.median.toFixed(2)}x`}
                hint={efficiencyPhrase(entry.median, entry.n, meta.noun)}
              />
            );
          })}
        </CardBody>
        <p className="border-t border-border px-4 py-2.5 text-2xs text-fg-subtle">
          Only battles where both sides reported the metric count, so a ratio never compares a measured number
          against a missing one. Below 1.00x is cheaper than the opponent.
        </p>
      </Card>

      {/* ---- rating history ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Rating history</CardTitle>
          <span className="text-2xs text-fg-subtle">
            {primary
              ? `${primary.agentId} · overall · community pool`
              : 'no rated battles under any agent yet'}
          </span>
        </CardHeader>
        <div className="border-t border-border">
          <RatingChart points={history} label={`${harness.name} community overall rating`} />
          {history.length > 0 ? (
            <TableWrap>
              <Table caption="Rating events">
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Battle</TH>
                    <TH>Opponent</TH>
                    <TH>Commit</TH>
                    <TH>Outcome</TH>
                    <TH className="text-right">Rating</TH>
                    <TH className="text-right">Δ</TH>
                  </TR>
                </THead>
                <TBody>
                  {[...history].reverse().map((point) => (
                    <TR key={`${point.battleId}-${point.at}`}>
                      <TD mono>{formatUtcDate(point.at)}</TD>
                      <TD>
                        <Link
                          href={`/battles/${point.battleId}`}
                          className="font-mono text-2xs text-accent hover:underline"
                        >
                          {point.battleId.slice(0, 14)}
                        </Link>
                      </TD>
                      <TD>
                        {point.opponentSlug ? (
                          <Link href={`/harnesses/${point.opponentSlug}`} className="hover:text-accent">
                            {point.opponentSlug}
                          </Link>
                        ) : (
                          <span className="text-fg-subtle">unknown</span>
                        )}
                      </TD>
                      <TD mono className="text-fg-muted">
                        {point.harnessCommit ? shortCommit(point.harnessCommit) : 'unpinned'}
                      </TD>
                      <TD>
                        <FormGlyphs
                          form={point.outcome === 'win' ? 'W' : point.outcome === 'loss' ? 'L' : 'T'}
                        />
                      </TD>
                      <TD mono className="text-right">
                        <RatingValue rating={point.rating} deviation={point.deviation} />
                      </TD>
                      <TD mono className="text-right">
                        {point.delta >= 0 ? '+' : ''}
                        {point.delta.toFixed(1)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          ) : null}
        </div>
      </Card>

      {/* ---- head to head ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Head-to-head</CardTitle>
          <span className="text-2xs text-fg-subtle">Harnesses it has actually fought</span>
        </CardHeader>
        <div className="border-t border-border">
          {opponents.length === 0 ? (
            <p className="px-4 py-3 text-[0.8125rem] text-fg-muted">
              No public battle pairs this harness with another one yet.
            </p>
          ) : (
            <TableWrap>
              <Table caption="Opponents">
                <THead>
                  <TR>
                    <TH>Opponent</TH>
                    <TH className="text-right">Battles</TH>
                    <TH className="text-right">W / L / T</TH>
                    <TH className="text-right">Inconclusive</TH>
                    <TH>Last</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {opponents.map((opponent) => (
                    <TR key={opponent.slug}>
                      <TD>
                        <Link href={`/harnesses/${opponent.slug}`} className="font-medium hover:text-accent">
                          {opponent.name}
                        </Link>
                      </TD>
                      <TD mono className="text-right">
                        {opponent.battles}
                      </TD>
                      <TD mono className="text-right">
                        {opponent.wins} / {opponent.losses} / {opponent.ties}
                      </TD>
                      <TD mono className="text-right text-fg-muted">
                        {opponent.inconclusive}
                      </TD>
                      <TD mono className="text-fg-muted">
                        {opponent.lastBattleAt ? formatUtcDate(opponent.lastBattleAt) : '—'}
                      </TD>
                      <TD>
                        <Link
                          href={`/harnesses/${slug}/vs/${opponent.slug}`}
                          className="text-2xs text-accent hover:underline"
                        >
                          full record
                        </Link>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </div>
      </Card>

      {/* ---- insights ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>What the numbers say</CardTitle>
          <span className="text-2xs text-fg-subtle">Derived arithmetic, no model</span>
        </CardHeader>
        <CardBody>
          {insightResult.insights.length === 0 ? (
            <p className="text-[0.8125rem] text-fg-muted">
              Nothing clears the sample thresholds yet. A category needs 5 rated battles and an efficiency
              ratio needs 5 paired ones before this section will say anything about them.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {insightResult.insights.map((insight) => (
                <li key={insight.text} className="flex gap-2 text-[0.8125rem] leading-relaxed">
                  <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                  <span>{insight.text}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* ---- versions ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Versions tested</CardTitle>
          <span className="text-2xs text-fg-subtle">
            One row per commit Arena has seen; the record is from the rating audit trail.
          </span>
        </CardHeader>
        <div className="border-t border-border">
          {versions.length === 0 ? (
            <p className="px-4 py-3 text-[0.8125rem] text-fg-muted">No versions recorded.</p>
          ) : (
            <TableWrap>
              <Table caption="Harness versions">
                <THead>
                  <TR>
                    <TH>Commit</TH>
                    <TH>arena.yaml</TH>
                    <TH>Inspected</TH>
                    <TH>Seen</TH>
                    <TH className="text-right">Battles</TH>
                    <TH className="text-right">W / L / T</TH>
                  </TR>
                </THead>
                <TBody>
                  {versions.map((version) => (
                    <TR key={version.id}>
                      <TD mono>{version.commit ? shortCommit(version.commit, 10) : 'unpinned'}</TD>
                      <TD>
                        {version.manifest ? (
                          <span className="font-mono text-2xs">
                            {version.manifest.name}
                            {version.manifest.version ? ` v${version.manifest.version}` : ''}
                          </span>
                        ) : (
                          <span className="text-2xs text-fg-subtle">auto-detected</span>
                        )}
                      </TD>
                      <TD>{version.inspection ? 'yes' : 'no'}</TD>
                      <TD mono>{formatUtcDate(version.createdAt.toISOString())}</TD>
                      <TD mono className="text-right">
                        {version.battles}
                      </TD>
                      <TD mono className="text-right">
                        {version.wins} / {version.losses} / {version.ties}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </div>
      </Card>

      {/* ---- lineage ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Lineage</CardTitle>
          <span className="text-2xs text-fg-subtle">Declared, never inferred</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3 text-[0.8125rem]">
          {!lineage || (lineage.ancestors.length === 0 && lineage.descendants.length === 0) ? (
            <p className="text-fg-muted">
              No ancestry is declared for this harness. Arena never infers one: an edge comes from GitHub fork
              metadata, from the harness&apos;s own arena.yaml, or from a person saying so.
            </p>
          ) : (
            <>
              {[
                { title: 'Derived from', edges: lineage.ancestors, other: 'parentSlug' as const },
                { title: 'Descendants', edges: lineage.descendants, other: 'harnessSlug' as const },
              ]
                .filter((group) => group.edges.length > 0)
                .map((group) => (
                  <div key={group.title}>
                    <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                      {group.title}
                    </h3>
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {group.edges.map((edge) => {
                        const target = edge[group.other];
                        return (
                          <li
                            key={`${edge.relation}-${edge.parentSource}-${target ?? ''}`}
                            className="flex flex-wrap items-center gap-2"
                          >
                            {target ? (
                              <Link href={`/harnesses/${target}`} className="font-medium hover:text-accent">
                                {target}
                              </Link>
                            ) : (
                              <span className="font-mono text-2xs text-fg-muted">{edge.parentSource}</span>
                            )}
                            <Badge variant="outline" mono>
                              {edge.relation}
                            </Badge>
                            <Badge variant="neutral" title="Where this claim came from">
                              evidence: {edge.evidence}
                            </Badge>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
            </>
          )}
        </CardBody>
      </Card>

      {/* ---- challenges ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Challenge history</CardTitle>
          <span className="text-2xs text-fg-subtle">{challenges.length} public challenges</span>
        </CardHeader>
        <div className="border-t border-border">
          {challenges.length === 0 ? (
            <p className="px-4 py-3 text-[0.8125rem] text-fg-muted">
              Nobody has challenged this harness yet.{' '}
              <Link
                href={`/challenges/new?b=${encodeURIComponent(slug)}`}
                className="text-accent hover:underline"
              >
                Open the first one
              </Link>
              .
            </p>
          ) : (
            <TableWrap>
              <Table caption="Challenges naming this harness">
                <THead>
                  <TR>
                    <TH>Challenge</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Battles</TH>
                    <TH>Opened</TH>
                  </TR>
                </THead>
                <TBody>
                  {challenges.map((challenge) => (
                    <TR key={challenge.id}>
                      <TD>
                        <Link href={`/challenges/${challenge.id}`} className="font-medium hover:text-accent">
                          {challenge.title}
                        </Link>
                      </TD>
                      <TD>
                        <Badge variant={challenge.status === 'completed' ? 'success' : 'neutral'}>
                          {challenge.status}
                        </Badge>
                      </TD>
                      <TD mono className="text-right">
                        {challenge.battleIds.length}
                      </TD>
                      <TD mono className="text-fg-muted">
                        {formatUtcDate(challenge.createdAt)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </div>
      </Card>

      {/* ---- inspection (unchanged behaviour) ---- */}
      <div className="mt-4">
        {latestInspection ? (
          <InspectionCard inspection={latestInspection} title={harness.name} sourceUrl={harness.sourceUrl} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>No inspection yet</CardTitle>
            </CardHeader>
            <CardBody className="text-[0.8125rem] text-fg-muted">
              This harness was discovered from a battle, so Arena has its identity and manifest but has not
              inspected the repository. Import it from{' '}
              <a href="/harnesses/import" className="text-accent hover:underline">
                /harnesses/import
              </a>{' '}
              to fill in the feature grid.
            </CardBody>
          </Card>
        )}
      </div>

      {/* ---- README badges ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>README badges</CardTitle>
          <span className="text-2xs text-fg-subtle">
            Live SVG; every one states its sample or says provisional.
          </span>
        </CardHeader>
        <div className="border-t border-border">
          <TableWrap>
            <Table caption="Badge markdown">
              <THead>
                <TR>
                  <TH>Badge</TH>
                  <TH>Preview</TH>
                  <TH>Markdown</TH>
                </TR>
              </THead>
              <TBody>
                {BADGE_KINDS.map((kind) => (
                  <TR key={kind}>
                    <TD>{BADGE_KIND_LABELS[kind]}</TD>
                    <TD>
                      {/* a plain <img>: the badge is an SVG route on this origin, so next/image
                          would add an optimizer hop for a file that is already a few hundred bytes */}
                      <img
                        src={badgeUrl(kind)}
                        alt={`${BADGE_KIND_LABELS[kind]} badge for ${harness.name}`}
                        height={20}
                      />
                    </TD>
                    <TD>
                      <CodeBlock
                        copyable
                        language="markdown"
                        code={`[![${BADGE_KIND_LABELS[kind]}](${origin}${badgeUrl(kind)})](${origin}/harnesses/${slug})`}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </div>
      </Card>

      {/* ---- run it ---- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Battle it</CardTitle>
        </CardHeader>
        <CardBody>
          <CodeBlock
            terminal
            code={`${BRAND.cli.bin} battle --task "Fix the failing test" --a vanilla --b ${harness.sourceUrl ?? harness.slug}`}
          />
        </CardBody>
      </Card>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold">Recent public battles</h2>
        <BattleList
          battles={recentBattles}
          empty={
            <p className="rounded-card border border-border bg-surface px-4 py-3 text-[0.8125rem] text-fg-muted">
              No public battles reference this harness yet.
            </p>
          }
        />
      </section>

      <GlickoFootnote className="mt-6" />
      {overallPerformance ? (
        <p className="mt-2 text-2xs text-fg-subtle">
          Every figure on this page is computed over the {profile.analyzedBattles} most recent decided public
          battles ({overallPerformance.battles} counted towards the overall row).
        </p>
      ) : null}
    </Container>
  );
}
