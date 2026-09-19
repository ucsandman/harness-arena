'use client';

import { Check, Link2 } from 'lucide-react';
import { useState } from 'react';

/** Copies an absolute link to the clipboard, and says so when the browser refuses. */
export function CopyLinkButton({ url, label = 'Copy link' }: { url: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setState('copied');
          window.setTimeout(() => setState('idle'), 1600);
        } catch {
          setState('failed');
        }
      }}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 text-xs font-medium text-fg hover:bg-bg-subtle"
    >
      {state === 'copied' ? <Check size={13} aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}
