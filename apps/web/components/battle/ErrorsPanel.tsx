import type { ArenaEvent, BattleRecord } from '@harness-arena/protocol';
import { CircleCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { eventSummary, isProblem } from '@/lib/events';
import { formatDurationShort } from '@/lib/format';
import { SideChip } from './shared';

function severityOf(event: ArenaEvent): { variant: 'danger' | 'warn' | 'neutral'; label: string } {
  if (event.type === 'error')
    return {
      variant: event.payload.fatal ? 'danger' : 'warn',
      label: event.payload.fatal ? 'fatal' : 'error',
    };
  if (event.type === 'interrupt') return { variant: 'danger', label: 'interrupt' };
  if (event.type === 'limit.hit') return { variant: 'warn', label: 'limit' };
  if (event.type === 'human.intervention') return { variant: 'warn', label: 'human' };
  if (event.type === 'context.compacted') return { variant: 'neutral', label: 'compaction' };
  return { variant: 'warn', label: 'warning' };
}

/** Everything that went wrong, per side, plus the run-level error when a run failed outright. */
export function ErrorsPanel({
  record,
  events,
  className,
}: {
  record: BattleRecord;
  events: ArenaEvent[];
  className?: string;
}) {
  const problems = events.filter(isProblem);
  const runErrors = (['a', 'b'] as const)
    .map((side) => ({ side, error: record.runs[side].error }))
    .filter((entry): entry is { side: 'a' | 'b'; error: { code: string; message: string } } => !!entry.error);

  if (problems.length === 0 && runErrors.length === 0) {
    return (
      <p className={cn('flex items-center gap-2 text-xs text-fg-muted', className)}>
        <CircleCheck size={14} className="text-success" aria-hidden="true" />
        No errors, warnings, limits or human interventions were recorded on either side.
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {runErrors.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {runErrors.map((entry) => (
            <li
              key={entry.side}
              className="rounded-card border border-danger-border bg-danger-subtle p-3 text-xs text-danger"
            >
              <div className="flex items-center gap-2">
                <SideChip side={entry.side} />
                <span className="font-mono text-2xs">{entry.error.code}</span>
              </div>
              <p className="mt-1 break-words">{entry.error.message}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="divide-y divide-border rounded-card border border-border bg-surface">
        {problems.map((event) => {
          const severity = severityOf(event);
          return (
            <li key={event.id} className="flex gap-3 px-3 py-2 text-xs">
              <span className="w-12 shrink-0 font-mono tabular-nums text-fg-subtle">
                {formatDurationShort(event.tOffsetMs)}
              </span>
              <span className="shrink-0">
                {event.side ? <SideChip side={event.side} /> : <Badge variant="outline">battle</Badge>}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={severity.variant}>{severity.label}</Badge>
                  <span className="font-mono text-2xs text-fg-muted">{event.type}</span>
                </span>
                <span className="mt-0.5 block break-words">{eventSummary(event, 400)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
