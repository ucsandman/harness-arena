'use client';

import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * A plain monospace block with a copy button. No syntax highlighter on purpose: the text is rendered
 * as React children, never as HTML.
 */
export function CodeBlock({
  code,
  filename,
  language,
  className,
  maxHeight,
  copyable = true,
  terminal = false,
}: {
  code: string;
  filename?: string;
  /** shown as a label only; nothing is parsed */
  language?: string;
  className?: string;
  maxHeight?: number;
  copyable?: boolean;
  terminal?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setFailed(true);
    }
  }, [code]);

  return (
    <div className={cn('overflow-hidden rounded-card border border-border bg-code-bg', className)}>
      {filename || language || copyable ? (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-sunken px-3 py-1.5">
          <span className="truncate font-mono text-2xs text-fg-muted">
            {filename ?? (terminal ? 'terminal' : (language ?? 'text'))}
          </span>
          {copyable ? (
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-fg-muted hover:bg-bg-subtle hover:text-fg"
              aria-label={copied ? 'Copied to clipboard' : 'Copy code to clipboard'}
            >
              {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              {failed ? 'Press Ctrl+C' : copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </div>
      ) : null}
      <pre
        className="overflow-auto px-3.5 py-3 font-mono text-xs leading-relaxed text-code-fg"
        style={maxHeight ? { maxHeight } : undefined}
        tabIndex={0}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
