import type { MetricStatus, RunStatus, Side } from '@harness-arena/protocol';
import { Badge, STATUS_GLYPH, type BadgeVariant } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { METRIC_STATUS_TEXT } from '@/lib/metrics';
import { cn } from '@/lib/cn';
import { sideName } from '@/lib/format';

export const SIDE_TEXT: Record<Side, string> = { a: 'text-side-a', b: 'text-side-b' };
export const SIDE_BG: Record<Side, string> = { a: 'bg-side-a-subtle', b: 'bg-side-b-subtle' };
export const SIDE_BORDER: Record<Side, string> = { a: 'border-side-a-border', b: 'border-side-b-border' };
export const SIDE_DOT: Record<Side, string> = { a: 'bg-side-a', b: 'bg-side-b' };

/** Side identity: colour plus the letter, so colour is never the only signal. */
export function SideChip({ side, label, className }: { side: Side; label?: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium',
        SIDE_BG[side],
        SIDE_BORDER[side],
        SIDE_TEXT[side],
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', SIDE_DOT[side])} aria-hidden="true" />
      <span className="font-mono">{sideName(side)}</span>
      {label ? <span className="font-sans font-normal text-fg-muted">{label}</span> : null}
    </span>
  );
}

/** Telemetry provenance for one number. Glyph + tooltip + screen-reader text. */
export function MetricStatusBadge({ status, note }: { status: MetricStatus; note?: string }) {
  const explain = METRIC_STATUS_TEXT[status] ?? status;
  return (
    <Tooltip label={note ? `${explain} ${note}` : explain}>
      <Badge variant={status} mono className="uppercase">
        {STATUS_GLYPH[status]}
      </Badge>
    </Tooltip>
  );
}

const RUN_STATUS_VARIANT: Record<RunStatus, BadgeVariant> = {
  pending: 'neutral',
  preparing: 'neutral',
  running: 'accent',
  completed: 'success',
  failed: 'danger',
  timed_out: 'warn',
  cancelled: 'neutral',
  interrupted: 'warn',
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge variant={RUN_STATUS_VARIANT[status]}>{status.replace('_', ' ')}</Badge>;
}

/** A value that is not available. Never a zero. */
export function Unavailable({ note }: { note?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-fg-subtle">n/a</span>
      {note ? (
        <Tooltip label={note}>
          <span className="text-2xs text-fg-subtle underline decoration-dotted">why</span>
        </Tooltip>
      ) : null}
    </span>
  );
}
