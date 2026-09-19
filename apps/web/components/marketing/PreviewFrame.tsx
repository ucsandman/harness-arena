import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

/**
 * A framed product viewport. What is inside is the real UI rendered from real protocol types, not a
 * screenshot, so the badge says plainly that the data is a demo.
 */
export function PreviewFrame({
  children,
  title,
  note,
  maxHeight = 720,
  className,
}: {
  children: ReactNode;
  title: string;
  note?: string;
  maxHeight?: number;
  className?: string;
}) {
  return (
    <div
      className={cn('overflow-hidden rounded-card border border-border bg-bg-subtle shadow-sm', className)}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
        </span>
        <span className="truncate font-mono text-2xs text-fg-muted">{title}</span>
        <Badge variant="demo" className="ml-auto">
          Demo data
        </Badge>
      </div>
      <div className="overflow-y-auto p-3 sm:p-4" style={{ maxHeight }}>
        {children}
      </div>
      {note ? (
        <p className="border-t border-border bg-surface px-3 py-2 text-2xs text-fg-subtle">{note}</p>
      ) : null}
    </div>
  );
}
