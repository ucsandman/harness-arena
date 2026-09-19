import { cn } from '@/lib/cn';

/**
 * The arena mark: two chevrons facing each other across a centre line. Side A colour on the left,
 * side B colour on the right, matching the two competitors everywhere else in the product.
 */
export function LogoMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M4 6l5 6-5 6" stroke="var(--color-side-a)" />
      <path d="M20 6l-5 6 5 6" stroke="var(--color-side-b)" />
      <path d="M12 3.5v17" stroke="var(--color-border-strong)" strokeWidth="1.5" />
    </svg>
  );
}

export function Logo({
  className,
  showName = true,
  name,
}: {
  className?: string;
  showName?: boolean;
  name: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark />
      {showName ? <span className="text-sm font-semibold tracking-tight">{name}</span> : null}
    </span>
  );
}
