import type { Metadata } from 'next';
import { ArrowRight, Terminal } from 'lucide-react';
import { BattleReport } from '@/components/battle/BattleReport';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { PreviewFrame } from '@/components/marketing/PreviewFrame';
import {
  CliSection,
  DevelopersSection,
  EvaluationSection,
  HarnessImport,
  HarnessProtocolSection,
  HowItWorks,
  LocalExecution,
  PrivacySection,
  ReportsSection,
  SupportedAgents,
  VerifiedBattles,
} from '@/components/marketing/sections';
import { BRAND } from '@/lib/brand';
import { SAMPLE_REPORT } from '@/lib/sample-battle';

export const metadata: Metadata = {
  title: `${BRAND.name}: ${BRAND.tagline}`,
  description:
    'Battle two AI coding agent harnesses on the same task through the CLIs you already pay for. Local execution, ' +
    'honest telemetry, deterministic evaluation, and a battle report you can argue with.',
  alternates: { canonical: '/' },
  openGraph: {
    title: `${BRAND.name}: ${BRAND.tagline}`,
    description: 'Battle coding agent setups on the same task and see what actually performs better.',
    url: '/',
  },
};

function Hero() {
  return (
    <Container className="pt-14 pb-10 sm:pt-20">
      <div className="flex max-w-3xl flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="accent" mono>
            local execution
          </Badge>
          <Badge variant="outline">no duplicated AI spend</Badge>
          <Badge variant="outline">honest telemetry</Badge>
        </div>
        <h1 className="text-3xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">{BRAND.tagline}</h1>
        <p className="max-w-2xl text-base leading-relaxed text-fg-muted sm:text-lg">
          Battle coding agent setups on the same task and see what actually performs better.
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button href="/docs/cli" size="lg" iconRight={<ArrowRight size={16} aria-hidden="true" />}>
            Run a battle
          </Button>
          <Button href="/battles" size="lg" variant="secondary">
            View battles
          </Button>
        </div>
        <p className="flex flex-wrap items-center gap-2 font-mono text-xs text-fg-subtle">
          <Terminal size={13} aria-hidden="true" />
          {BRAND.cli.npx} battle
          <span className="font-sans">runs on your machine, through your own authenticated CLIs.</span>
        </p>
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

export default function LandingPage() {
  return (
    <>
      <Hero />

      <Container className="pb-12">
        <PreviewFrame
          title={`${BRAND.cli.bin} report ${SAMPLE_REPORT.record.id}`}
          note="This is the live report UI rendered from a sample battle record, not a screenshot. Scroll it, scrub the timeline, filter the events."
        >
          <BattleReport record={SAMPLE_REPORT.record} events={SAMPLE_REPORT.events} />
        </PreviewFrame>
      </Container>

      <HowItWorks />
      <LocalExecution />
      <HarnessImport />
      <SupportedAgents />
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
