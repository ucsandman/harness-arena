import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Container({
  children,
  className,
  size = 'default',
}: {
  children: ReactNode;
  className?: string;
  size?: 'default' | 'wide' | 'prose';
}) {
  const width = size === 'wide' ? 'max-w-[1400px]' : size === 'prose' ? 'max-w-3xl' : 'max-w-6xl';
  return <div className={cn('mx-auto w-full px-4 sm:px-6 lg:px-8', width, className)}>{children}</div>;
}
