import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { GitHubIcon } from '@/components/ui/GitHubIcon';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { Logo } from './Logo';
import { MobileMenu, type NavItem } from './MobileMenu';

/**
 * Battles, Harnesses and Leaderboard are data-backed pages built in a later wave. The links exist so
 * the shell is complete; only Docs and the marketing page render today.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: '/battles', label: 'Battles' },
  { href: '/harnesses', label: 'Harnesses' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/docs', label: 'Docs' },
];

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-sm">
      <div className="relative mx-auto flex h-14 w-full max-w-[1400px] items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="rounded-md" aria-label={`${BRAND.name} home`}>
          <Logo name={BRAND.name} />
        </Link>

        <nav aria-label="Main" className="hidden md:flex md:items-center md:gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-2.5 py-1.5 text-[0.8125rem] font-medium text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <a
            href={BRAND.github}
            target="_blank"
            rel="noreferrer noopener"
            className="hidden h-8 w-8 items-center justify-center rounded-md border border-border text-fg-muted hover:bg-bg-subtle hover:text-fg sm:inline-flex"
            aria-label={`${BRAND.name} on GitHub`}
          >
            <GitHubIcon size={15} />
          </a>
          <ThemeToggle />
          <Link
            href="/login"
            className="hidden rounded-md border border-border px-2.5 py-1.5 text-[0.8125rem] font-medium text-fg-muted hover:bg-bg-subtle hover:text-fg sm:inline-flex"
          >
            Sign in
          </Link>
          <MobileMenu items={NAV_ITEMS} github={BRAND.github} />
        </div>
      </div>
    </header>
  );
}
