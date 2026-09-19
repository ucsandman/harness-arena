import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeVariant =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'danger'
  | 'warn'
  | 'outline'
  | 'side-a'
  | 'side-b'
  | 'observed'
  | 'calculated'
  | 'estimated'
  | 'unavailable'
  | 'demo';

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: 'bg-neutral-subtle text-fg-muted border-border',
  accent: 'bg-accent-subtle text-accent border-accent-border',
  success: 'bg-success-subtle text-success border-success-border',
  danger: 'bg-danger-subtle text-danger border-danger-border',
  warn: 'bg-warn-subtle text-warn border-warn-border',
  outline: 'bg-transparent text-fg-muted border-border-strong',
  'side-a': 'bg-side-a-subtle text-side-a border-side-a-border',
  'side-b': 'bg-side-b-subtle text-side-b border-side-b-border',
  observed: 'bg-success-subtle text-success border-success-border',
  calculated: 'bg-accent-subtle text-accent border-accent-border',
  estimated: 'bg-warn-subtle text-warn border-warn-border',
  unavailable: 'bg-neutral-subtle text-fg-subtle border-border',
  demo: 'bg-warn-subtle text-warn border-warn-border',
};

/** Short glyph so status is never carried by colour alone. */
export const STATUS_GLYPH: Record<'observed' | 'calculated' | 'estimated' | 'unavailable', string> = {
  observed: 'obs',
  calculated: 'calc',
  estimated: 'est',
  unavailable: 'n/a',
};

export interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
  /** small leading icon, decorative */
  icon?: ReactNode;
  title?: string;
  mono?: boolean;
}

export function Badge({ variant = 'neutral', children, className, icon, title, mono }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium leading-4',
        mono && 'font-mono tabular-nums',
        VARIANTS[variant],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
