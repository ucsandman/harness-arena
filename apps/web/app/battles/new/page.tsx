import type { Metadata } from 'next';
import { NewBattleForm } from '@/components/battles/NewBattleForm';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'New battle spec',
  description: 'Describe a battle: one task, one commit, two harnesses. Then run it on your own machine.',
  robots: { index: false, follow: false },
};

export default async function NewBattlePage() {
  await requireUser('/battles/new');

  return (
    <Container className="py-10">
      <SectionHeading
        eyebrow="new battle"
        title="Describe the battle"
        description="Both sides get the same task, the same commit and the same limits. The only difference is the harness (and the agent, if you pick two different CLIs)."
      />
      <div className="mt-6">
        <NewBattleForm />
      </div>
    </Container>
  );
}
