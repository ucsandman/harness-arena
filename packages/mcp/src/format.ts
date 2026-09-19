import { humanDuration } from '@harness-arena/core';
import type { MetricKey, MetricValue } from '@harness-arena/protocol';

/**
 * How a metric is shown to a caller. `unavailable` never becomes a number: the value stays null and
 * the display string is "n/a", so a reader can never mistake "the CLI does not report this" for zero.
 */
export interface MetricCell {
  value: number | string | boolean | null;
  status: MetricValue['status'];
  /** short badge for a table: observed | calculated | estimated | n/a */
  badge: string;
  /** human-readable value: "n/a", "34.2 seconds", "$0.41", "12" */
  display: string;
  unit?: string;
  source?: string;
  note?: string;
}

export function metricCell(key: MetricKey, metric: MetricValue | undefined): MetricCell {
  const value = metric?.value ?? null;
  const status = metric?.status ?? 'unavailable';
  const cell: MetricCell = {
    value: status === 'unavailable' ? null : value,
    status,
    badge: status === 'unavailable' ? 'n/a' : status,
    display: display(key, status, value),
  };
  if (metric?.unit) cell.unit = metric.unit;
  if (metric?.source) cell.source = metric.source;
  if (metric?.note) cell.note = metric.note;
  return cell;
}

function display(key: MetricKey, status: MetricValue['status'], value: MetricValue['value']): string {
  if (status === 'unavailable' || value === null) return 'n/a';
  if (typeof value === 'number') {
    if (key === 'duration_ms') return humanDuration(value);
    if (key === 'cost_usd') return '$' + value.toFixed(value < 1 ? 4 : 2);
    return String(value);
  }
  return String(value);
}
