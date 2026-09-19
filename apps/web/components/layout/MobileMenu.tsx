'use client';

import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { GitHubIcon } from '@/components/ui/GitHubIcon';

export interface NavItem {
  href: string;
  label: string;
}

export function MobileMenu({ items, github }: { items: NavItem[]; github: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? 'Close menu' : 'Open menu'}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-fg-muted hover:bg-bg-subtle hover:text-fg"
      >
        {open ? <X size={15} aria-hidden="true" /> : <Menu size={15} aria-hidden="true" />}
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute left-0 right-0 top-full border-b border-border bg-surface shadow-lg"
      >
        <nav aria-label="Mobile" className="flex flex-col p-2">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-bg-subtle hover:text-fg"
            >
              {item.label}
            </Link>
          ))}
          <Link
            href="/login"
            onClick={() => setOpen(false)}
            className="rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-bg-subtle hover:text-fg"
          >
            Sign in
          </Link>
          <a
            href={github}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-bg-subtle hover:text-fg"
          >
            <GitHubIcon size={14} />
            GitHub
          </a>
        </nav>
      </div>
    </div>
  );
}
