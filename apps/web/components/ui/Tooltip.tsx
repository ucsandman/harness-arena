import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * CSS-only tooltip: no JS, works in server components. The label is also rendered for screen
 * readers, so hover is never the only way to get the information.
 */
export function Tooltip({
  label,
  children,
  side = 'top',
  className,
}: {
  label: string;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}) {
  return (
    <span className={cn('group/tip relative inline-flex items-center', className)}>
      <span tabIndex={0} className="inline-flex items-center rounded outline-offset-2">
        {children}
        <span className="sr-only"> ({label})</span>
      </span>
      <span
        role="tooltip"
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute left-1/2 z-30 w-max max-w-64 -translate-x-1/2 rounded-md border ' +
            'border-border bg-surface-raised px-2 py-1 text-2xs font-normal leading-4 text-fg shadow-lg ' +
            'opacity-0 transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {label}
      </span>
    </span>
  );
}
