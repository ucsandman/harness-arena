import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DocsSidebar } from '@/components/docs/DocsSidebar';
import { DocPlaceholder, Markdown } from '@/components/docs/Markdown';
import { Container } from '@/components/ui/Container';
import { DOC_PAGES, docHref, findDocPage, loadDocPage } from '@/lib/docs';

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

/** One entry per registry page. Unknown slugs 404 instead of touching the file system. */
export function generateStaticParams(): Array<{ slug: string[] }> {
  return DOC_PAGES.map((page) => ({ slug: page.slug ? page.slug.split('/') : [] }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = findDocPage(slug);
  if (!page) return { title: 'Documentation', robots: { index: false, follow: false } };
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: docHref(page) },
    openGraph: { title: page.title, description: page.description, url: docHref(page) },
  };
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = await loadDocPage(slug);
  if (!doc) notFound();

  return (
    <Container className="py-10" size="wide">
      <div className="grid gap-8 lg:grid-cols-[210px_minmax(0,1fr)]">
        <aside>
          <DocsSidebar current={doc.page} />
        </aside>

        <article className="min-w-0">
          {doc.markdown ? (
            <Markdown markdown={doc.markdown} />
          ) : (
            <DocPlaceholder title={doc.page.title} description={doc.page.description} />
          )}

          <nav
            aria-label="Pagination"
            className="mt-12 flex flex-wrap items-stretch justify-between gap-3 border-t border-border pt-5"
          >
            {doc.prev ? (
              <Link
                href={docHref(doc.prev)}
                className="group flex min-w-0 flex-1 items-center gap-2 rounded-card border border-border px-3 py-2 hover:border-border-strong"
              >
                <ChevronLeft size={15} className="shrink-0 text-fg-subtle" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-2xs text-fg-subtle">Previous</span>
                  <span className="block truncate text-xs font-medium">{doc.prev.title}</span>
                </span>
              </Link>
            ) : (
              <span className="flex-1" />
            )}
            {doc.next ? (
              <Link
                href={docHref(doc.next)}
                className="group flex min-w-0 flex-1 items-center justify-end gap-2 rounded-card border border-border px-3 py-2 text-right hover:border-border-strong"
              >
                <span className="min-w-0">
                  <span className="block text-2xs text-fg-subtle">Next</span>
                  <span className="block truncate text-xs font-medium">{doc.next.title}</span>
                </span>
                <ChevronRight size={15} className="shrink-0 text-fg-subtle" aria-hidden="true" />
              </Link>
            ) : (
              <span className="flex-1" />
            )}
          </nav>
        </article>
      </div>
    </Container>
  );
}
