'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SessionUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

const ITEMS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/settings', label: 'Settings' },
];

/** Avatar + account menu. Sign out is a form post, so it works without client-side JavaScript. */
export function UserMenu({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onClick = (event: MouseEvent): void => {
      if (container.current && !container.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-1.5 text-[0.8125rem] font-medium text-fg-muted hover:bg-bg-subtle hover:text-fg"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" width={20} height={20} className="h-5 w-5 rounded-full" />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-subtle font-mono text-2xs">
            {user.login.slice(0, 2).toUpperCase()}
          </span>
        )}
        <span className="hidden max-w-24 truncate sm:inline">{user.login}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full z-50 mt-1 w-44 rounded-card border border-border bg-surface p-1 shadow-lg"
      >
        <p className="truncate px-2 py-1.5 text-2xs text-fg-subtle">{user.name ?? user.login}</p>
        {ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className="block rounded px-2 py-1.5 text-[0.8125rem] text-fg-muted hover:bg-bg-subtle hover:text-fg"
          >
            {item.label}
          </Link>
        ))}
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="w-full rounded px-2 py-1.5 text-left text-[0.8125rem] text-fg-muted hover:bg-bg-subtle hover:text-fg"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
