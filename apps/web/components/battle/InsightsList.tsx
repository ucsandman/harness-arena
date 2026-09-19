import type { Insight } from '@harness-arena/protocol';
import { Activity, Gauge, ShieldCheck, Timer, TriangleAlert } from 'lucide-react';
import type { ComponentType } from 'react';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { SIDE_TEXT } from './shared';

const KIND_ICON: Record<Insight['kind'], ComponentType<{ size?: number; className?: string }>> = {
  timing: Timer,
  efficiency: Gauge,
  behavior: Activity,
  quality: ShieldCheck,
  warning: TriangleAlert,
};

const KIND_LABEL: Record<Insight['kind'], string> = {
  timing: 'timing',
  efficiency: 'efficiency',
  behavior: 'behavior',
  quality: 'quality',
  warning: 'warning',
};

/** Observations derived from telemetry. Each one names the metrics behind it. */
export function InsightsList({ insights, className }: { insights: Insight[]; className?: string }) {
  if (insights.length === 0) {
    return (
      <p className={cn('text-xs text-fg-muted', className)}>
        No insights were derived for this battle. Insights only appear when the telemetry supports them.
      </p>
    );
  }

  return (
    <ul className={cn('grid gap-2 sm:grid-cols-2', className)}>
      {insights.map((insight) => {
        const Icon = KIND_ICON[insight.kind];
        const favours = insight.favors === 'a' || insight.favors === 'b' ? insight.favors : null;
        return (
          <li key={insight.id} className="rounded-card border border-border bg-surface p-3">
            <div className="flex items-center gap-2">
              <Icon
                size={14}
                className={insight.kind === 'warning' ? 'text-warn' : 'text-fg-muted'}
                aria-hidden="true"
              />
              <span className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                {KIND_LABEL[insight.kind]}
              </span>
              {favours ? (
                <span className={cn('ml-auto text-2xs font-medium', SIDE_TEXT[favours])}>
                  favours {favours.toUpperCase()}
                </span>
              ) : (
                <span className="ml-auto text-2xs text-fg-subtle">favours neither</span>
              )}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed">{insight.text}</p>
            {insight.support.metrics.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {insight.support.metrics.map((metric) => (
                  <Badge key={metric} variant="outline" mono>
                    {metric}
                  </Badge>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
