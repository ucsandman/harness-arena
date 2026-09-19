'use client';

import type { ArenaEvent, BattleRecord, Side } from '@harness-arena/protocol';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Kbd } from '@/components/ui/Kbd';
import { cn } from '@/lib/cn';
import { categoryLabel, categoryOf, eventSummary, type EventCategoryId } from '@/lib/events';
import { formatDurationShort } from '@/lib/format';
import { SideChip } from './shared';

/** Fixed viewBox: the SVG stretches horizontally, so marker maths stays in one coordinate space. */
const VIEW_WIDTH = 1000;
const COLUMNS = 500;
const LANE_HEIGHT = 34;
const LANE_GAP = 10;
const AXIS_HEIGHT = 18;
const SVG_HEIGHT = AXIS_HEIGHT + LANE_HEIGHT * 2 + LANE_GAP;
/** A marker on one side with nothing on the other inside this window is a divergence point. */
const DIVERGENCE_WINDOW_MS = 5000;
const MAX_DIVERGENCE_MARKS = 40;
const ZOOM_STEPS = [1, 2, 4, 8, 16] as const;

const CATEGORY_COLOR: Record<EventCategoryId, string> = {
  lifecycle: 'var(--color-fg-subtle)',
  model: 'var(--color-accent)',
  tools: 'var(--color-side-a)',
  files: 'var(--color-success)',
  commands: 'var(--color-fg-muted)',
  tests: 'var(--color-side-b)',
  subagents: 'var(--color-accent-border)',
  problems: 'var(--color-danger)',
};

const CATEGORY_PRIORITY: EventCategoryId[] = [
  'problems',
  'tests',
  'commands',
  'files',
  'subagents',
  'tools',
  'model',
  'lifecycle',
];

interface Marker {
  column: number;
  t: number;
  seq: number;
  category: EventCategoryId;
  count: number;
}

interface LaneData {
  markers: Marker[];
  total: number;
}

function buildLane(events: readonly ArenaEvent[], start: number, span: number): LaneData {
  const byColumn = new Map<number, Marker>();
  let total = 0;
  for (const event of events) {
    const t = event.tOffsetMs;
    if (t < start || t > start + span) continue;
    total += 1;
    const column = Math.min(COLUMNS - 1, Math.max(0, Math.floor(((t - start) / span) * COLUMNS)));
    const category = categoryOf(event.type);
    const existing = byColumn.get(column);
    if (!existing) {
      byColumn.set(column, { column, t, seq: event.seq, category, count: 1 });
      continue;
    }
    existing.count += 1;
    if (CATEGORY_PRIORITY.indexOf(category) < CATEGORY_PRIORITY.indexOf(existing.category)) {
      existing.category = category;
      existing.seq = event.seq;
      existing.t = t;
    }
  }
  return { markers: [...byColumn.values()].sort((x, y) => x.column - y.column), total };
}

function lastBefore(events: readonly ArenaEvent[], t: number): ArenaEvent | null {
  let found: ArenaEvent | null = null;
  for (const event of events) {
    if (event.tOffsetMs > t) break;
    found = event;
  }
  return found;
}

/**
 * Both runs on one shared time axis. Markers are bucketed per column before rendering, so a battle
 * with thousands of events still draws a bounded number of SVG nodes.
 */
export function Timeline({
  events,
  record,
  className,
}: {
  events: ArenaEvent[];
  record: BattleRecord;
  className?: string;
}) {
  const maxT = useMemo(() => events.reduce((max, event) => Math.max(max, event.tOffsetMs), 1), [events]);

  const sorted = useMemo(() => {
    const bySide: Record<Side, ArenaEvent[]> = { a: [], b: [] };
    for (const event of events) {
      if (event.side === 'a' || event.side === 'b') bySide[event.side].push(event);
    }
    bySide.a.sort((x, y) => x.tOffsetMs - y.tOffsetMs);
    bySide.b.sort((x, y) => x.tOffsetMs - y.tOffsetMs);
    return bySide;
  }, [events]);

  const [zoomIndex, setZoomIndex] = useState(0);
  const [center, setCenter] = useState(maxT / 2);
  const [currentT, setCurrentT] = useState(maxT);

  const zoom = ZOOM_STEPS[zoomIndex] ?? 1;
  const span = Math.max(1000, maxT / zoom);
  const start = Math.min(Math.max(0, center - span / 2), Math.max(0, maxT - span));

  const laneA = useMemo(() => buildLane(sorted.a, start, span), [sorted.a, start, span]);
  const laneB = useMemo(() => buildLane(sorted.b, start, span), [sorted.b, start, span]);

  const divergences = useMemo(() => {
    const marks: Array<{ column: number; side: Side; t: number }> = [];
    const hasNear = (list: readonly ArenaEvent[], t: number) =>
      list.some((event) => Math.abs(event.tOffsetMs - t) <= DIVERGENCE_WINDOW_MS);
    for (const marker of laneA.markers) {
      if (!hasNear(sorted.b, marker.t)) marks.push({ column: marker.column, side: 'a', t: marker.t });
      if (marks.length >= MAX_DIVERGENCE_MARKS) return marks;
    }
    for (const marker of laneB.markers) {
      if (!hasNear(sorted.a, marker.t)) marks.push({ column: marker.column, side: 'b', t: marker.t });
      if (marks.length >= MAX_DIVERGENCE_MARKS) return marks;
    }
    return marks;
  }, [laneA.markers, laneB.markers, sorted.a, sorted.b]);

  const currentA = useMemo(() => lastBefore(sorted.a, currentT), [sorted.a, currentT]);
  const currentB = useMemo(() => lastBefore(sorted.b, currentT), [sorted.b, currentT]);

  const x = (t: number) => ((t - start) / span) * VIEW_WIDTH;
  const columnX = (column: number) => (column / COLUMNS) * VIEW_WIDTH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => start + span * fraction);

  const onScrub = (value: number) => {
    setCurrentT(value);
    if (value < start || value > start + span) setCenter(value);
  };

  return (
    <section
      className={cn('rounded-card border border-border bg-surface', className)}
      aria-label="Battle timeline"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Timeline</h3>
          <Badge variant="outline" mono>
            {events.length} events
          </Badge>
          {record.spec.parallel ? (
            <Badge variant="warn">ran in parallel</Badge>
          ) : (
            <Badge variant="neutral">sequential</Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-2xs tabular-nums text-fg-muted">
            {formatDurationShort(currentT)} / {formatDurationShort(maxT)}
          </span>
          <button
            type="button"
            onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
            disabled={zoomIndex === 0}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-fg-muted hover:bg-bg-subtle disabled:opacity-40"
            aria-label="Zoom out"
          >
            <ZoomOut size={13} aria-hidden="true" />
          </button>
          <span className="w-8 text-center font-mono text-2xs tabular-nums text-fg-muted">{zoom}x</span>
          <button
            type="button"
            onClick={() => {
              setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1));
              setCenter(currentT);
            }}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-fg-muted hover:bg-bg-subtle disabled:opacity-40"
            aria-label="Zoom in"
          >
            <ZoomIn size={13} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="px-3 py-3">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${SVG_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-28 w-full"
          role="img"
          aria-label={`Event markers for both runs between ${formatDurationShort(start)} and ${formatDurationShort(start + span)}`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={x(tick)}
                x2={x(tick)}
                y1={AXIS_HEIGHT}
                y2={SVG_HEIGHT}
                stroke="var(--color-border)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={Math.min(x(tick) + 4, VIEW_WIDTH - 40)}
                y={12}
                fontSize={11}
                fill="var(--color-fg-subtle)"
              >
                {formatDurationShort(tick)}
              </text>
            </g>
          ))}

          {[
            { side: 'a' as Side, lane: laneA, y: AXIS_HEIGHT },
            { side: 'b' as Side, lane: laneB, y: AXIS_HEIGHT + LANE_HEIGHT + LANE_GAP },
          ].map(({ side, lane, y }) => (
            <g key={side}>
              <rect
                x={0}
                y={y}
                width={VIEW_WIDTH}
                height={LANE_HEIGHT}
                fill={side === 'a' ? 'var(--color-side-a-subtle)' : 'var(--color-side-b-subtle)'}
                opacity={0.5}
              />
              {lane.markers.map((marker) => (
                <rect
                  key={`${side}-${marker.column}`}
                  x={columnX(marker.column)}
                  y={y + 4}
                  width={2}
                  height={Math.min(LANE_HEIGHT - 8, 6 + marker.count * 4)}
                  fill={CATEGORY_COLOR[marker.category]}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          ))}

          {divergences.map((mark, index) => (
            <line
              key={`${mark.side}-${mark.column}-${index}`}
              x1={columnX(mark.column)}
              x2={columnX(mark.column)}
              y1={AXIS_HEIGHT}
              y2={SVG_HEIGHT}
              stroke="var(--color-warn)"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <line
            x1={x(currentT)}
            x2={x(currentT)}
            y1={0}
            y2={SVG_HEIGHT}
            stroke="var(--color-fg)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        <label className="mt-3 block">
          <span className="sr-only">Battle time (arrow keys step through the timeline)</span>
          <input
            type="range"
            min={0}
            max={Math.round(maxT)}
            step={Math.max(50, Math.round(maxT / 600))}
            value={Math.round(currentT)}
            onChange={(event) => onScrub(Number(event.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-sunken accent-[var(--color-accent)]"
            aria-valuetext={`${formatDurationShort(currentT)} into the battle`}
          />
        </label>

        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-2xs text-fg-subtle">
          <span>
            <Kbd>&larr;</Kbd> <Kbd>&rarr;</Kbd> to step
          </span>
          <span>
            Dashed amber: one side acted with nothing from the other inside {DIVERGENCE_WINDOW_MS / 1000}s.
          </span>
        </p>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[
            { side: 'a' as Side, event: currentA, label: record.runs.a.label, total: laneA.total },
            { side: 'b' as Side, event: currentB, label: record.runs.b.label, total: laneB.total },
          ].map(({ side, event, label, total }) => (
            <div key={side} className="min-w-0 rounded-md border border-border bg-bg-subtle p-2.5">
              <div className="flex items-center gap-2">
                <SideChip side={side} />
                <span className="min-w-0 flex-1 truncate text-2xs text-fg-muted">{label}</span>
                <span className="font-mono text-2xs tabular-nums text-fg-subtle">{total} in view</span>
              </div>
              {event ? (
                <div className="mt-1.5">
                  <div className="flex items-center gap-2 font-mono text-2xs text-fg-subtle">
                    <span className="tabular-nums">{formatDurationShort(event.tOffsetMs)}</span>
                    <span>{event.type}</span>
                    <span className="truncate">{categoryLabel(categoryOf(event.type))}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs">{eventSummary(event, 180)}</p>
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-fg-subtle">Nothing yet on this side at this point.</p>
              )}
            </div>
          ))}
        </div>

        <ul className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(CATEGORY_COLOR) as EventCategoryId[]).map((category) => (
            <li key={category} className="inline-flex items-center gap-1.5 text-2xs text-fg-muted">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-sm"
                style={{ backgroundColor: CATEGORY_COLOR[category] }}
              />
              {categoryLabel(category)}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
