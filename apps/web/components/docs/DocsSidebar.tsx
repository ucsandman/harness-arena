import Link from 'next/link';
import { DOC_PAGES, docHref, type DocPage } from '@/lib/docs';
import { cn } from '@/lib/cn';

/** Registry order, rendered as the docs navigation. */
export function DocsSidebar({ current }: { current: DocPage }) {
  return (
    <nav aria-label="Documentation" className="lg:sticky lg:top-20">
      <h2 className="px-2 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">Documentation</h2>
      <ul className="mt-2 flex flex-col gap-0.5">
        {DOC_PAGES.map((page) => {
          const active = page.slug === current.slug;
          return (
            <li key={page.slug || 'overview'}>
              <Link
                href={docHref(page)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'block rounded-md px-2 py-1.5 text-xs transition-colors',
                  active
                    ? 'bg-accent-subtle font-medium text-accent'
                    : 'text-fg-muted hover:bg-bg-subtle hover:text-fg',
                )}
              >
                {page.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
