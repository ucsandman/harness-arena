import type { MetricKey, MetricValue, RunMetrics, Side } from '@harness-arena/protocol';
import { ChevronDown, ChevronUp, Minus } from 'lucide-react';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/cn';
import { METRIC_GROUPS, buildMetricRows, isAvailable, type MetricRow } from '@/lib/metrics';
import { MetricStatusBadge, SIDE_TEXT, Unavailable } from './shared';

function DirectionHint({ direction }: { direction: 'lower' | 'higher' | 'none' }) {
  if (direction === 'none') {
    return (
      <Tooltip label="Not comparable: neither direction is better on its own.">
        <Minus size={11} className="text-fg-subtle" aria-hidden="true" />
      </Tooltip>
    );
  }
  const Icon = direction === 'lower' ? ChevronDown : ChevronUp;
  return (
    <Tooltip label={direction === 'lower' ? 'Lower is better' : 'Higher is better'}>
      <Icon size={11} className="text-fg-subtle" aria-hidden="true" />
    </Tooltip>
  );
}

function MetricCell({
  side,
  metric,
  text,
  better,
}: {
  side: Side;
  metric: MetricValue | undefined;
  text: string;
  better: boolean;
}) {
  const available = isAvailable(metric);
  return (
    <TD className={cn('align-top', better && 'bg-bg-subtle')}>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'font-mono tabular-nums',
            available ? (better ? cn('font-semibold', SIDE_TEXT[side]) : 'text-fg') : 'text-fg-subtle',
          )}
        >
          {available ? text : <Unavailable note={metric?.note} />}
        </span>
        {better ? (
          <span className={cn('text-2xs font-medium', SIDE_TEXT[side])}>
            better<span className="sr-only"> on this metric</span>
          </span>
        ) : null}
        {metric ? <MetricStatusBadge status={metric.status} note={metric.note} /> : null}
      </div>
      {metric?.source && isAvailable(metric) ? (
        <p className="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{metric.source}</p>
      ) : null}
    </TD>
  );
}

function Row({ row }: { row: MetricRow }) {
  return (
    <TR>
      <TH scope="row" className="w-2/5 min-w-40 align-top font-medium">
        <span className="flex items-center gap-1.5">
          {row.label}
          <DirectionHint direction={row.direction} />
        </span>
        <span className="mt-0.5 block font-mono text-2xs font-normal text-fg-subtle">{row.key}</span>
      </TH>
      <MetricCell side="a" metric={row.a} text={row.aText} better={row.better === 'a'} />
      <MetricCell side="b" metric={row.b} text={row.bText} better={row.better === 'b'} />
    </TR>
  );
}

/**
 * Every metric in the curated order, A against B. A value that the CLI does not report shows n/a with
 * the reason; it is never rendered as 0, and it never wins or loses a comparison.
 */
export function MetricsTable({
  a,
  b,
  labelA,
  labelB,
  keys,
  grouped = true,
  hideDoubleUnavailable = false,
  className,
}: {
  a: RunMetrics;
  b: RunMetrics;
  labelA: string;
  labelB: string;
  keys?: readonly MetricKey[];
  grouped?: boolean;
  hideDoubleUnavailable?: boolean;
  className?: string;
}) {
  const rows = buildMetricRows(a, b, { keys, hideDoubleUnavailable });
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return (
    <TableWrap className={cn('rounded-card border border-border bg-surface', className)}>
      <Table caption={`Metrics for ${labelA} against ${labelB}`}>
        <THead>
          <TR>
            <TH className="w-2/5">Metric</TH>
            <TH>
              <span className={cn('inline-flex items-center gap-1.5', SIDE_TEXT.a)}>
                <span className="h-1.5 w-1.5 rounded-full bg-side-a" aria-hidden="true" />A
                <span className="truncate font-normal normal-case text-fg-muted">{labelA}</span>
              </span>
            </TH>
            <TH>
              <span className={cn('inline-flex items-center gap-1.5', SIDE_TEXT.b)}>
                <span className="h-1.5 w-1.5 rounded-full bg-side-b" aria-hidden="true" />B
                <span className="truncate font-normal normal-case text-fg-muted">{labelB}</span>
              </span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {grouped
            ? METRIC_GROUPS.flatMap((group) => {
                const groupRows = group.keys
                  .map((key) => byKey.get(key))
                  .filter((row): row is MetricRow => !!row);
                if (groupRows.length === 0) return [];
                return [
                  <TR key={`group-${group.id}`}>
                    <TD colSpan={3} className="bg-surface-sunken py-1.5">
                      <span className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                        {group.label}
                      </span>
                      <span className="ml-2 text-2xs text-fg-subtle">{group.hint}</span>
                    </TD>
                  </TR>,
                  ...groupRows.map((row) => <Row key={row.key} row={row} />),
                ];
              })
            : rows.map((row) => <Row key={row.key} row={row} />)}
        </TBody>
      </Table>
    </TableWrap>
  );
}
