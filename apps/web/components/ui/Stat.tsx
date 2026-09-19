import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Stat({
  label,
  value,
  hint,
  side,
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  side?: 'a' | 'b';
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-fg-muted">
        {icon}
        {label}
      </span>
      <span
        className={cn(
          'truncate font-mono text-lg font-semibold tabular-nums',
          side === 'a' && 'text-side-a',
          side === 'b' && 'text-side-b',
        )}
      >
        {value}
      </span>
      {hint ? <span className="truncate text-2xs text-fg-subtle">{hint}</span> : null}
    </div>
  );
}
