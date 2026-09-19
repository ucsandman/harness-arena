'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { clampText, stripAnsi } from '@/lib/ansi';

/** Long agent text, clamped with an explicit expand control. ANSI escapes are removed first. */
export function ExpandableText({
  text,
  max = 420,
  className,
  mono = false,
  label = 'text',
}: {
  text: string;
  max?: number;
  className?: string;
  mono?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const clean = stripAnsi(text);
  const { text: short, truncated } = clampText(clean, max);

  return (
    <div className={cn('flex flex-col items-start gap-1.5', className)}>
      <p className={cn('whitespace-pre-wrap break-words text-xs leading-relaxed', mono && 'font-mono')}>
        {open || !truncated ? clean : `${short}...`}
      </p>
      {truncated ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded text-2xs font-medium text-accent hover:underline"
          aria-expanded={open}
        >
          {open ? `Show less ${label}` : `Show full ${label} (${clean.length.toLocaleString('en-US')} chars)`}
        </button>
      ) : null}
    </div>
  );
}
