import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function SectionHeading({
  eyebrow,
  title,
  description,
  id,
  align = 'left',
  className,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  id?: string;
  align?: 'left' | 'center';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-2', align === 'center' && 'items-center text-center', className)}>
      {eyebrow ? (
        <span className="font-mono text-2xs font-medium uppercase tracking-[0.14em] text-accent">
          {eyebrow}
        </span>
      ) : null}
      <h2 id={id} className="text-xl font-semibold sm:text-2xl">
        {title}
      </h2>
      {description ? (
        <p
          className={cn(
            'max-w-2xl text-[0.9375rem] leading-relaxed text-fg-muted',
            align === 'center' && 'mx-auto',
          )}
        >
          {description}
        </p>
      ) : null}
      {children}
    </div>
  );
}
