import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return <Tag className={cn('rounded-card border border-border bg-surface', className)}>{children}</Tag>;
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  children,
  className,
  as: Tag = 'h3',
}: {
  children: ReactNode;
  className?: string;
  as?: 'h2' | 'h3' | 'h4' | 'div';
}) {
  return <Tag className={cn('text-sm font-semibold', className)}>{children}</Tag>;
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-3.5', className)}>{children}</div>;
}

export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('border-t border-border bg-bg-subtle px-4 py-2.5 text-xs text-fg-muted', className)}>
      {children}
    </div>
  );
}
