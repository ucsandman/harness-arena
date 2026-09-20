import type { Metadata } from 'next';
import { NewChallengeForm } from '@/components/challenges/NewChallengeForm';
import { ExecutionNote } from '@/components/arena/shared';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { requireUser } from '@/lib/auth';
import { arenaFormOptions, sourceForSlug } from '@/lib/arena-options';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'New challenge',
  description: 'Define a matchup: two harnesses, one agent, one task. Somebody else runs it locally.',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ a?: string; b?: string }>;
}

export default async function NewChallengePage({ searchParams }: PageProps) {
  const user = await requireUser('/challenges/new');
  const { a, b } = await searchParams;

  const dbh = await db();
  const options = await arenaFormOptions(dbh, user.id);

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="new challenge"
        title="Define the matchup"
        description="A challenge carries the task itself, so accepting it never means trusting your description of the work. You do not have to run anything: whoever accepts it does."
      />
      <ExecutionNote className="mt-6" />
      <div className="mt-6">
        <NewChallengeForm
          harnesses={options.harnesses}
          benchmarks={options.benchmarks}
          agents={options.agents}
          defaultA={sourceForSlug(options.harnesses, a) || 'vanilla'}
          defaultB={sourceForSlug(options.harnesses, b)}
        />
      </div>
    </Container>
  );
}
