'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem {
  id: string;
  label: string;
  /** small count shown after the label */
  count?: number;
  content: ReactNode;
}

/**
 * Accessible tabs: one tab stop for the whole list (roving tabindex), arrow/Home/End navigation,
 * and only the selected panel mounted.
 */
export function Tabs({
  items,
  initialId,
  className,
  label = 'Sections',
}: {
  items: TabItem[];
  initialId?: string;
  className?: string;
  label?: string;
}) {
  const first = items[0];
  const [active, setActive] = useState(initialId ?? first?.id ?? '');
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const index = Math.max(
    0,
    items.findIndex((item) => item.id === active),
  );

  const focusTab = (next: number) => {
    const bounded = (next + items.length) % items.length;
    const item = items[bounded];
    if (!item) return;
    setActive(item.id);
    refs.current[bounded]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusTab(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusTab(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(items.length - 1);
        break;
      default:
        break;
    }
  };

  const activeItem = items[index];

  return (
    <div className={cn('flex flex-col', className)}>
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-border">
        {items.map((item, i) => {
          const selected = item.id === activeItem?.id;
          return (
            <button
              key={item.id}
              ref={(node) => {
                refs.current[i] = node;
              }}
              id={`${base}-tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${base}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(item.id)}
              onKeyDown={onKeyDown}
              className={cn(
                '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.8125rem] font-medium transition-colors',
                selected
                  ? 'border-accent text-fg'
                  : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <span className="font-mono text-2xs tabular-nums text-fg-subtle">{item.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {activeItem ? (
        <div
          id={`${base}-panel-${activeItem.id}`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${activeItem.id}`}
          tabIndex={0}
          className="pt-4 outline-offset-4"
        >
          {activeItem.content}
        </div>
      ) : null}
    </div>
  );
}
