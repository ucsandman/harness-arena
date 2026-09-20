import type { Metadata } from 'next';
import { ArrowRight, Terminal } from 'lucide-react';
import { getLeaderboard } from '@harness-arena/database';
import { BattleReport } from '@/components/battle/BattleReport';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { PreviewFrame } from '@/components/marketing/PreviewFrame';
import {
  CliSection,
  CommunityLeaderboard,
  DevelopersSection,
  EvaluationSection,
  HarnessImport,
  HarnessProtocolSection,
  HeroMatchup,
  HowItWorks,
  LocalExecution,
  PrivacySection,
  ProveIt,
  ReportsSection,
  SupportedAgents,
  VerifiedBattles,
  type LandingLeaderboardRow,
} from '@/components/marketing/sections';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { loadLandingBattle, type LandingBattle } from '@/lib/demo-battle';

// the preview and the leaderboard are read from the database, so this page is per-request
export const dynamic = 'force-dynamic';

/** The one sentence that says what this site answers. Kept verbatim on the hero. */
const LEDE = 'Find out whether your AI coding setup actually makes your agent better.';

export const metadata: Metadata = {
  title: `${BRAND.name}: ${BRAND.tagline}`,
  description:
    `${LEDE} Battle two AI coding agent harnesses on the same task through the CLIs you already pay for. ` +
    'Local execution, honest telemetry, deterministic evaluation, and a battle report you can argue with.',
  alternates: { canonical: '/' },
  openGraph: {
    title: `${BRAND.name}: ${BRAND.tagline}`,
    description: LEDE,
    url: '/',
  },
};

function Hero({ demo }: { demo: LandingBattle }) {
  return (
    <Container className="pt-14 pb-10 sm:pt-20">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-center">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="accent" mono>
              local execution
            </Badge>
            <Badge variant="outline">no duplicated AI spend</Badge>
            <Badge variant="outline">honest telemetry</Badge>
          </div>
          <h1 className="text-3xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">{BRAND.tagline}</h1>
          <p className="max-w-2xl text-base leading-relaxed text-fg-muted sm:text-lg">{LEDE}</p>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button href="/docs/cli" size="lg" iconRight={<ArrowRight size={16} aria-hidden="true" />}>
              Run a battle
            </Button>
            <Button href="/leaderboard" size="lg" variant="secondary">
              See the leaderboard
            </Button>
          </div>
          <p className="flex flex-wrap items-center gap-2 font-mono text-xs text-fg-subtle">
            <Terminal size={13} aria-hidden="true" />
            {BRAND.cli.npx} battle
            <span className="font-sans">runs on your machine, through your own authenticated CLIs.</span>
          </p>
        </div>
        <HeroMatchup record={demo.record} />
      </div>
    </Container>
  );
}

function FinalCta() {
  return (
    <section className="border-t border-border py-16">
      <Container>
        <div className="flex flex-col items-start gap-4 rounded-card border border-border bg-surface p-6 sm:p-8">
          <h2 className="max-w-2xl text-xl font-semibold sm:text-2xl">
            You already have the agents. Find out which setup is actually better.
          </h2>
          <p className="max-w-2xl text-[0.9375rem] text-fg-muted">
            One command, two harnesses, the same task and commit. The report tells you what it measured, what
            it derived, and what it could not see.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <Button href="/docs/cli" iconRight={<ArrowRight size={15} aria-hidden="true" />}>
              Install the CLI
            </Button>
            <Button href="/docs" variant="secondary">
              Read the docs
            </Button>
            <Button href={BRAND.github} variant="ghost" external>
              Browse the source
            </Button>
          </div>
        </div>
      </Container>
    </section>
  );
}

/**
 * Top community ratings for the landing page. Ranks are assigned over the ranked rows only, so the
 * table can never number a provisional rating; the provisional count is passed through so the empty
 * state can say how much unranked evidence exists instead of implying nobody has run anything.
 */
async function landingLeaderboard(): Promise<{ rows: LandingLeaderboardRow[]; provisional: number }> {
  try {
    const dbh = await db();
    const all = await getLeaderboard(dbh, { category: 'overall', pool: 'community', limit: 50 });
    const rows = all
      .filter((row) => !row.provisional)
      .slice(0, 5)
      .map((row, index) => ({
        rank: index + 1,
        harnessSlug: row.harnessSlug,
        harnessName: row.harnessName,
        agentId: row.agentId,
        rating: row.rating,
        deviation: row.deviation,
        battles: row.battles,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
      }));
    return { rows, provisional: all.filter((row) => row.provisional).length };
  } catch {
    // no database reachable: the honest empty state is better than a failed page
    return { rows: [], provisional: 0 };
  }
}

export default async function LandingPage() {
  const [demo, leaderboard] = await Promise.all([loadLandingBattle(), landingLeaderboard()]);
  const note =
    demo.source === 'database'
      ? `This is the live report UI rendered from the seeded demo battle in the database (${demo.events.length} events), not a screenshot. Scroll it, scrub the timeline, filter the events.`
      : 'This is the live report UI rendered from a bundled sample battle record, not a screenshot. Scroll it, scrub the timeline, filter the events.';

  return (
    <>
      <Hero demo={demo} />

      <Container className="pb-12">
        <PreviewFrame title={`${BRAND.cli.bin} report ${demo.record.id}`} note={note}>
          <BattleReport record={demo.record} events={demo.events} />
        </PreviewFrame>
      </Container>

      <HowItWorks />
      <CommunityLeaderboard rows={leaderboard.rows} provisional={leaderboard.provisional} />
      <SupportedAgents />
      <ProveIt />
      <LocalExecution />
      <HarnessImport />
      <ReportsSection />
      <EvaluationSection />
      <PrivacySection />
      <VerifiedBattles />
      <HarnessProtocolSection />
      <CliSection />
      <DevelopersSection />
      <FinalCta />
    </>
  );
}
