import type { Metadata } from 'next';
import { NewBountyForm } from '@/components/bounties/NewBountyForm';
import { ExecutionNote } from '@/components/arena/shared';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { requireUser } from '@/lib/auth';
import { arenaFormOptions } from '@/lib/arena-options';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'New bounty',
  description: 'Name a baseline, a target and a condition made of numbers. Arena moves no money.',
  robots: { index: false, follow: false },
};

export default async function NewBountyPage() {
  const user = await requireUser('/bounties/new');
  const dbh = await db();
  const options = await arenaFormOptions(dbh, user.id);

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="new bounty"
        title="Post a bounty"
        description="Beat this baseline on this task and you will say so publicly. State the condition as numbers a battle can actually report: a check that cannot be evaluated counts as not met."
      />
      <ExecutionNote className="mt-6" />
      <div className="mt-6">
        <NewBountyForm
          harnesses={options.harnesses}
          benchmarks={options.benchmarks}
          agents={options.agents}
        />
      </div>
    </Container>
  );
}
