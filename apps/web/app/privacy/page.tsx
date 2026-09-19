import type { Metadata } from 'next';
import Link from 'next/link';
import { DocPlaceholder, Markdown } from '@/components/docs/Markdown';
import { Container } from '@/components/ui/Container';
import { findDocPage, readDocFile } from '@/lib/docs';

const PAGE = findDocPage('privacy');

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    PAGE?.description ?? 'What Harness Arena keeps on your machine, and exactly what an upload contains.',
  alternates: { canonical: '/privacy' },
};

/** Same source and same renderer as /docs/privacy, at the URL people expect. */
export default async function PrivacyPage() {
  if (!PAGE) return null;
  const markdown = await readDocFile(PAGE);
  return (
    <Container className="py-10" size="prose">
      {markdown ? (
        <Markdown markdown={markdown} />
      ) : (
        <DocPlaceholder title="Privacy" description={PAGE.description} />
      )}
      <p className="mt-10 border-t border-border pt-4 text-xs text-fg-muted">
        This page renders <span className="font-mono">docs/PRIVACY.md</span> from the repository. See also the{' '}
        <Link href="/security" className="text-accent hover:underline">
          security model
        </Link>
        .
      </p>
    </Container>
  );
}
