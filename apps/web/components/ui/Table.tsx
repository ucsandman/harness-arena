import type { ReactNode, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-full overflow-x-auto', className)}>{children}</div>;
}

export function Table({
  children,
  className,
  caption,
}: {
  children: ReactNode;
  className?: string;
  caption?: string;
}) {
  return (
    <table className={cn('w-full text-left text-[0.8125rem]', className)}>
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      {children}
    </table>
  );
}

export function THead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead className={cn('bg-surface-sunken text-2xs uppercase tracking-wide text-fg-muted', className)}>
      {children}
    </thead>
  );
}

export function TBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={cn('divide-y divide-border', className)}>{children}</tbody>;
}

export function TR({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={className}>{children}</tr>;
}

export function TH({
  children,
  className,
  scope = 'col',
  ...rest
}: { children?: ReactNode; className?: string } & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope={scope} className={cn('px-3 py-2 font-semibold', className)} {...rest}>
      {children}
    </th>
  );
}

export function TD({
  children,
  className,
  mono,
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  mono?: boolean;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn('px-3 py-2 align-middle', mono && 'font-mono tabular-nums', className)}
    >
      {children}
    </td>
  );
}
