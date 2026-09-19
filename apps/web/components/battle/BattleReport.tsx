import type { ArenaEvent, BattleRecord } from '@harness-arena/protocol';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { ExpandableText } from '@/components/ui/ExpandableText';
import { cn } from '@/lib/cn';
import { HEADLINE_METRIC_KEYS, buildMetricRows } from '@/lib/metrics';
import { countByCategory } from '@/lib/events';
import { formatUtcDate, shortCommit } from '@/lib/format';
import { DiffViewer } from './DiffViewer';
import { EnvironmentPanel } from './EnvironmentPanel';
import { ErrorsPanel } from './ErrorsPanel';
import { EventLog } from './EventLog';
import { InsightsList } from './InsightsList';
import { MetricsTable } from './MetricsTable';
import { RunHeader } from './RunHeader';
import { TestResults } from './TestResults';
import { Timeline } from './Timeline';
import { VerdictBanner } from './VerdictBanner';
import { SIDE_TEXT } from './shared';

function SummaryStrip({ record, events }: { record: BattleRecord; events: ArenaEvent[] }) {
  const rows = buildMetricRows(record.runs.a.metrics, record.runs.b.metrics, { keys: HEADLINE_METRIC_KEYS });
  return (
    <div className="rounded-card border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-semibold sm:text-lg">{record.task.title}</h1>
            {record.demo ? <Badge variant="demo">Demo data</Badge> : null}
            <Badge variant={record.status === 'completed' ? 'success' : 'neutral'}>{record.status}</Badge>
            {record.spec.category ? <Badge variant="outline">{record.spec.category}</Badge> : null}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs text-fg-muted">
            <span>{record.id}</span>
            <span>
              {record.repository.source} @ {shortCommit(record.repository.commit)}
            </span>
            <span>{formatUtcDate(record.createdAt)}</span>
            <span>{events.length} events</span>
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 divide-border border-b border-border sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
        {rows.map((row) => (
          <div key={row.key} className="border-b border-border px-4 py-2.5 last:border-b-0 lg:border-b-0">
            <dt className="text-2xs uppercase tracking-wide text-fg-subtle">{row.label}</dt>
            <dd className="mt-0.5 flex items-baseline gap-2 font-mono text-sm tabular-nums">
              <span className={cn(row.better === 'a' ? cn('font-semibold', SIDE_TEXT.a) : 'text-fg')}>
                {row.aText}
              </span>
              <span className="text-fg-subtle" aria-hidden="true">
                /
              </span>
              <span className={cn(row.better === 'b' ? cn('font-semibold', SIDE_TEXT.b) : 'text-fg')}>
                {row.bText}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="px-4 py-3">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
          Task given to both sides
        </h2>
        <ExpandableText text={record.task.prompt} max={280} label="prompt" className="mt-1" />
      </div>
    </div>
  );
}

/**
 * The whole battle report: summary, verdict, metrics, insights, timeline, then the raw evidence in tabs.
 * Pure presentation over protocol types, so it renders identically for a live battle, a replay, or the
 * sample bundle on the landing page.
 */
export function BattleReport({
  record,
  events,
  className,
}: {
  record: BattleRecord;
  events: ArenaEvent[];
  className?: string;
}) {
  const counts = countByCategory(events);
  const problemCount = counts.problems;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <SummaryStrip record={record} events={events} />

      <div className="grid gap-3 md:grid-cols-2">
        <RunHeader run={record.runs.a} />
        <RunHeader run={record.runs.b} />
      </div>

      <VerdictBanner record={record} />

      <section aria-labelledby="metrics-heading" className="flex flex-col gap-2">
        <h2 id="metrics-heading" className="text-sm font-semibold">
          Metrics
        </h2>
        <MetricsTable
          a={record.runs.a.metrics}
          b={record.runs.b.metrics}
          labelA={record.runs.a.label}
          labelB={record.runs.b.label}
        />
      </section>

      <section aria-labelledby="insights-heading" className="flex flex-col gap-2">
        <h2 id="insights-heading" className="text-sm font-semibold">
          Insights
        </h2>
        <InsightsList insights={record.insights} />
      </section>

      <Timeline events={events} record={record} />

      <Tabs
        label="Battle evidence"
        items={[
          { id: 'events', label: 'Events', count: events.length, content: <EventLog events={events} /> },
          {
            id: 'diff',
            label: 'Diff',
            content: (
              <DiffViewer
                diffA={record.runs.a.artifacts.diff ?? null}
                diffB={record.runs.b.artifacts.diff ?? null}
                labelA={record.runs.a.label}
                labelB={record.runs.b.label}
              />
            ),
          },
          { id: 'tests', label: 'Tests', content: <TestResults record={record} events={events} /> },
          {
            id: 'errors',
            label: 'Problems',
            count: problemCount,
            content: <ErrorsPanel record={record} events={events} />,
          },
          { id: 'environment', label: 'Environment', content: <EnvironmentPanel record={record} /> },
        ]}
      />
    </div>
  );
}
