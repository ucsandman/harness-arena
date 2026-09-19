import type { Metadata } from 'next';
import { Button } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <Container className="py-24">
      <p className="font-mono text-2xs uppercase tracking-[0.14em] text-accent">404</p>
      <h1 className="mt-2 text-2xl font-semibold">That page does not exist</h1>
      <p className="mt-2 max-w-xl text-[0.9375rem] text-fg-muted">
        The link may be from a later release. Battle pages, harness profiles and the leaderboard are still
        being built; the documentation is live now.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button href="/">Back to the landing page</Button>
        <Button href="/docs" variant="secondary">
          Read the docs
        </Button>
      </div>
    </Container>
  );
}
