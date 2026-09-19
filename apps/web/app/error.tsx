'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';

/**
 * Error boundary for the app shell. The message is shown as text; the digest is the only identifier
 * worth surfacing, and no stack or environment detail is rendered.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[arena-web] render error', { digest: error.digest });
  }, [error]);

  return (
    <Container className="py-24">
      <p className="font-mono text-2xs uppercase tracking-[0.14em] text-danger">Error</p>
      <h1 className="mt-2 text-2xl font-semibold">Something broke while rendering this page</h1>
      <p className="mt-2 max-w-xl text-[0.9375rem] text-fg-muted">
        The page failed to render. Retrying is safe: nothing here runs a battle or changes data.
      </p>
      {error.digest ? (
        <p className="mt-3 font-mono text-xs text-fg-subtle">
          digest <span className="tabular-nums">{error.digest}</span>
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button href="/" variant="secondary">
          Back to the landing page
        </Button>
      </div>
    </Container>
  );
}
