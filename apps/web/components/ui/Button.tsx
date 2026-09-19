import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-bg-subtle',
  ghost: 'bg-transparent text-fg-muted border border-transparent hover:bg-bg-subtle hover:text-fg',
  danger: 'bg-danger text-accent-fg border border-transparent hover:opacity-90',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md',
  lg: 'h-11 px-5 text-[0.9375rem] gap-2 rounded-lg',
};

const BASE =
  'inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors ' +
  'disabled:pointer-events-none disabled:opacity-50 select-none';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
  /** rendered before the label; decorative, so it is aria-hidden by the caller's icon component */
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
}

export type ButtonProps = CommonProps &
  (
    | {
        href: string;
        external?: boolean;
        onClick?: never;
        type?: never;
        disabled?: never;
        'aria-label'?: string;
      }
    | {
        href?: undefined;
        external?: never;
        onClick?: () => void;
        type?: 'button' | 'submit' | 'reset';
        disabled?: boolean;
        'aria-label'?: string;
      }
  );

export function Button(props: ButtonProps) {
  const { variant = 'primary', size = 'md', className, children, iconLeft, iconRight } = props;
  const classes = cn(BASE, VARIANTS[variant], SIZES[size], className);
  const content = (
    <>
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </>
  );

  if (props.href !== undefined) {
    if (props.external) {
      return (
        <a
          href={props.href}
          className={classes}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={props['aria-label']}
        >
          {content}
        </a>
      );
    }
    return (
      <Link href={props.href} className={classes} aria-label={props['aria-label']}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
      className={classes}
      aria-label={props['aria-label']}
    >
      {content}
    </button>
  );
}
