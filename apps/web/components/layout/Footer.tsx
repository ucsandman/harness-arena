import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { GitHubIcon } from '@/components/ui/GitHubIcon';
import { Logo } from './Logo';

interface FooterLink {
  href: string;
  label: string;
  external?: boolean;
}

/** Every link here resolves today: landing sections, docs pages, or the repository. */
const COLUMNS: Array<{ heading: string; links: FooterLink[] }> = [
  {
    heading: 'Product',
    links: [
      { href: '/#how-it-works', label: 'How it works' },
      { href: '/#reports', label: 'Battle reports' },
      { href: '/#evaluation', label: 'Evaluation' },
      { href: '/#cli', label: 'CLI' },
    ],
  },
  {
    heading: 'Developers',
    links: [
      { href: '/docs', label: 'Documentation' },
      { href: '/docs/architecture', label: 'Architecture' },
      { href: '/docs/protocol', label: 'Event protocol' },
      { href: '/docs/harness-protocol', label: 'arena.yaml' },
      { href: '/docs/adapters', label: 'Agent adapters' },
      { href: '/docs/contributing', label: 'Contributing' },
      { href: BRAND.github, label: 'GitHub', external: true },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/privacy', label: 'Privacy' },
      { href: '/security', label: 'Security' },
      { href: '/docs/cli', label: 'Local execution' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="mt-20 border-t border-border bg-bg-subtle">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-3">
            <Logo name={BRAND.name} />
            <p className="max-w-64 text-xs leading-relaxed text-fg-muted">{BRAND.description}</p>
            <a
              href={BRAND.github}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex w-fit items-center gap-1.5 text-xs text-fg-muted hover:text-fg"
            >
              <GitHubIcon size={13} />
              Source on GitHub
            </a>
          </div>
          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading} className="flex flex-col gap-2">
              <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                {column.heading}
              </h2>
              <ul className="flex flex-col gap-1.5">
                {column.links.map((link) => (
                  <li key={`${column.heading}-${link.href}`}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-xs text-fg-muted hover:text-fg"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className="text-xs text-fg-muted hover:text-fg">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-8 flex flex-col gap-1 border-t border-border pt-5 text-2xs text-fg-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>
            {BRAND.name} runs on your machine through the agent CLIs you already authenticate. It never
            proxies model traffic and never touches provider credentials.
          </p>
          <p className="font-mono">MIT licensed</p>
        </div>
      </div>
    </footer>
  );
}
