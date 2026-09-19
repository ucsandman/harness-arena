'use client';

import type { ArenaEvent, Side } from '@harness-arena/protocol';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import {
  EVENT_CATEGORIES,
  categoryOf,
  countByCategory,
  eventSummary,
  matchesQuery,
  type EventCategoryId,
} from '@/lib/events';
import { formatDurationShort } from '@/lib/format';
import { SIDE_DOT } from './shared';

const PAGE_SIZE = 200;

const CONFIDENCE_VARIANT = {
  observed: 'observed',
  derived: 'calculated',
  estimated: 'estimated',
} as const;

export function EventLog({ events, className }: { events: ArenaEvent[]; className?: string }) {
  const [active, setActive] = useState<Set<EventCategoryId>>(new Set());
  const [side, setSide] = useState<'all' | Side>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const counts = useMemo(() => countByCategory(events), [events]);

  const filtered = useMemo(() => {
    return events.filter((event) => {
      if (side !== 'all' && event.side !== side) return false;
      if (active.size > 0 && !active.has(categoryOf(event.type))) return false;
      return matchesQuery(event, query);
    });
  }, [events, side, active, query]);

  const shown = filtered.slice(0, limit);

  const toggleCategory = (id: EventCategoryId) => {
    setActive((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLimit(PAGE_SIZE);
  };

  return (
    <section className={cn('rounded-card border border-border bg-surface', className)} aria-label="Event log">
      <div className="flex flex-col gap-2.5 border-b border-border p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {EVENT_CATEGORIES.map((category) => {
            const selected = active.has(category.id);
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => toggleCategory(category.id)}
                aria-pressed={selected}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors',
                  selected
                    ? 'border-accent-border bg-accent-subtle text-accent'
                    : 'border-border text-fg-muted hover:bg-bg-subtle hover:text-fg',
                )}
              >
                {category.label}
                <span className="font-mono tabular-nums text-fg-subtle">{counts[category.id]}</span>
              </button>
            );
          })}
          {active.size > 0 ? (
            <button
              type="button"
              onClick={() => setActive(new Set())}
              className="rounded px-1.5 py-1 text-2xs text-accent hover:underline"
            >
              Clear types
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Side filter"
            className="inline-flex overflow-hidden rounded-md border border-border"
          >
            {(['all', 'a', 'b'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setSide(value);
                  setLimit(PAGE_SIZE);
                }}
                aria-pressed={side === value}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium',
                  side === value ? 'bg-bg-subtle text-fg' : 'text-fg-muted hover:bg-bg-subtle',
                )}
              >
                {value !== 'all' ? (
                  <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', SIDE_DOT[value])} />
                ) : null}
                {value === 'all' ? 'Both sides' : `Side ${value.toUpperCase()}`}
              </button>
            ))}
          </div>

          <label className="relative min-w-40 flex-1">
            <span className="sr-only">Search events</span>
            <Search
              size={13}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(PAGE_SIZE);
              }}
              placeholder="Search type, tool, path, message"
              className="h-8 w-full rounded-md border border-border bg-bg pl-8 pr-2.5 text-xs placeholder:text-fg-subtle"
            />
          </label>

          <span className="font-mono text-2xs tabular-nums text-fg-muted">
            {filtered.length} of {events.length}
          </span>
        </div>
      </div>

      <ol className="divide-y divide-border">
        {shown.map((event) => (
          <li key={event.id} className="flex gap-3 px-3 py-2 text-xs">
            <span className="w-12 shrink-0 font-mono tabular-nums text-fg-subtle">
              {formatDurationShort(event.tOffsetMs)}
            </span>
            <span
              className="w-4 shrink-0"
              aria-label={event.side ? `Side ${event.side.toUpperCase()}` : 'Battle'}
            >
              {event.side ? (
                <span
                  aria-hidden="true"
                  className={cn('inline-block h-2 w-2 rounded-full', SIDE_DOT[event.side])}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full border border-border-strong"
                />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-2xs text-fg-muted">{event.type}</span>
                <Badge variant={CONFIDENCE_VARIANT[event.confidence]} mono>
                  {event.confidence}
                </Badge>
                {event.source.native ? (
                  <span className="font-mono text-2xs text-fg-subtle">{event.source.native}</span>
                ) : null}
              </span>
              <span className="mt-0.5 block break-words">{eventSummary(event)}</span>
            </span>
            <span className="w-10 shrink-0 text-right font-mono tabular-nums text-fg-subtle">
              #{event.seq}
            </span>
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-fg-muted">No events match these filters.</li>
        ) : null}
      </ol>

      {filtered.length > shown.length ? (
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <span className="text-2xs text-fg-muted">
            Showing {shown.length} of {filtered.length} matching events
          </span>
          <Button size="sm" variant="secondary" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
            Load {Math.min(PAGE_SIZE, filtered.length - shown.length)} more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
