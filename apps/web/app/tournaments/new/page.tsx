import type { Metadata } from 'next';
import { NewTournamentForm } from '@/components/tournaments/NewTournamentForm';
import { ExecutionNote } from '@/components/arena/shared';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { requireUser } from '@/lib/auth';
import { arenaFormOptions } from '@/lib/arena-options';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'New tournament',
  description: 'Build a single-elimination bracket over 2 to 16 harnesses on one agent and one target.',
  robots: { index: false, follow: false },
};

export default async function NewTournamentPage() {
  const user = await requireUser('/tournaments/new');
  const dbh = await db();
  const options = await arenaFormOptions(dbh, user.id);

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="harness arena championship"
        title="Build a bracket"
        description="Every entrant runs the same agent on the same target. Seeding comes from the community overall ratings the entrants already hold, so the two best seeds can only meet in the final."
      />
      <ExecutionNote className="mt-6" />
      <div className="mt-6">
        <NewTournamentForm
          harnesses={options.harnesses}
          benchmarks={options.benchmarks}
          agents={options.agents}
        />
      </div>
    </Container>
  );
}
