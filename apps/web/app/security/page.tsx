import type { Metadata } from 'next';
import Link from 'next/link';
import { DocPlaceholder, Markdown } from '@/components/docs/Markdown';
import { Container } from '@/components/ui/Container';
import { findDocPage, readDocFile } from '@/lib/docs';

const PAGE = findDocPage('security');

export const metadata: Metadata = {
  title: 'Security',
  description: PAGE?.description ?? 'Trust boundaries, harness trust prompts, and what Arena never touches.',
  alternates: { canonical: '/security' },
};

/** Same source and same renderer as /docs/security, at the URL people expect. */
export default async function SecurityPage() {
  if (!PAGE) return null;
  const markdown = await readDocFile(PAGE);
  return (
    <Container className="py-10" size="prose">
      {markdown ? (
        <Markdown markdown={markdown} />
      ) : (
        <DocPlaceholder title="Security model" description={PAGE.description} />
      )}
      <p className="mt-10 border-t border-border pt-4 text-xs text-fg-muted">
        This page renders <span className="font-mono">docs/SECURITY.md</span> from the repository. See also{' '}
        <Link href="/privacy" className="text-accent hover:underline">
          privacy
        </Link>
        .
      </p>
    </Container>
  );
}
