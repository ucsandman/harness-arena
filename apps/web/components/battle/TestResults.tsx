import type { ArenaEvent, BattleRecord, MetricValue, Side } from '@harness-arena/protocol';
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { formatDurationShort } from '@/lib/format';
import { isAvailable } from '@/lib/metrics';
import { SideChip } from './shared';

interface TestTotals {
  passed: number | null;
  failed: number | null;
  total: number | null;
  durationMs: number | null;
}

function numberOf(metric: MetricValue | undefined): number | null {
  if (!isAvailable(metric)) return null;
  return typeof metric?.value === 'number' ? metric.value : null;
}

function baselineFor(events: readonly ArenaEvent[], side: Side | null): TestTotals | null {
  for (const event of events) {
    if (event.type !== 'test.completed') continue;
    if (event.payload.phase !== 'baseline') continue;
    if (event.side !== side && event.side !== null) continue;
    return {
      passed: event.payload.passed,
      failed: event.payload.failed,
      total: event.payload.total,
      durationMs: event.payload.durationMs,
    };
  }
  return null;
}

function Count({ label, value, tone }: { label: string; value: number | null; tone?: 'good' | 'bad' }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xs uppercase tracking-wide text-fg-subtle">{label}</span>
      <span
        className={cn(
          'font-mono text-base font-semibold tabular-nums',
          value === null && 'text-fg-subtle',
          value !== null && tone === 'good' && 'text-success',
          value !== null && tone === 'bad' && value > 0 && 'text-danger',
        )}
      >
        {value === null ? 'n/a' : value}
      </span>
    </div>
  );
}

/** Baseline against post-run results per side, so a pre-existing failure is never called a regression. */
export function TestResults({
  record,
  events,
  className,
}: {
  record: BattleRecord;
  events: ArenaEvent[];
  className?: string;
}) {
  const sides: Side[] = ['a', 'b'];

  const testsConfigured = !!record.spec.evaluation.tests;

  if (!testsConfigured) {
    return (
      <p className={cn('text-xs text-fg-muted', className)}>
        No test command was configured for this battle, so no test evidence exists. The verdict cannot rest on
        tests.
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <p className="font-mono text-2xs text-fg-muted">{record.spec.evaluation.tests?.command}</p>

      <div className="grid gap-3 md:grid-cols-2">
        {sides.map((side) => {
          // The engine runs a baseline per side, in that side's own workspace, and emits it with that
          // side (engine.ts test.completed, phase 'baseline'); a battle-level baseline (side null)
          // belongs to both sides.
          const baseline = baselineFor(events, side);
          const run = record.runs[side];
          const passed = numberOf(run.metrics.tests_passed);
          const failed = numberOf(run.metrics.tests_failed);
          const total = numberOf(run.metrics.tests_total);
          const regressions = numberOf(run.metrics.regressions);
          const green = failed === 0 && passed !== null;
          return (
            <Card key={side}>
              <CardHeader>
                <span className="flex min-w-0 items-center gap-2">
                  <SideChip side={side} />
                  <CardTitle className="truncate">{run.label}</CardTitle>
                </span>
                {green ? (
                  <span className="inline-flex items-center gap-1 text-2xs font-medium text-success">
                    <CircleCheck size={13} aria-hidden="true" />
                    suite green
                  </span>
                ) : failed !== null && failed > 0 ? (
                  <span className="inline-flex items-center gap-1 text-2xs font-medium text-danger">
                    <CircleX size={13} aria-hidden="true" />
                    {failed} failing
                  </span>
                ) : (
                  <span className="text-2xs text-fg-subtle">no result</span>
                )}
              </CardHeader>
              <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-6">
                  <Count label="Passed" value={passed} tone="good" />
                  <Count label="Failed" value={failed} tone="bad" />
                  <Count label="Total" value={total} />
                  <Count label="Regressions" value={regressions} tone="bad" />
                </div>
                {regressions !== null && regressions > 0 ? (
                  <p className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-subtle p-2 text-2xs text-danger">
                    <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>
                      {regressions} test{regressions === 1 ? '' : 's'} that passed at baseline now fail. That
                      is a regression this side introduced, not a pre-existing failure.
                    </span>
                  </p>
                ) : null}
                <div className="flex flex-col gap-1 border-t border-border pt-2">
                  <span className="text-2xs uppercase tracking-wide text-fg-subtle">
                    Baseline (before this run)
                  </span>
                  {baseline ? (
                    <div className="flex flex-wrap items-end gap-6">
                      <Count label="Passed" value={baseline.passed} />
                      <Count label="Failed" value={baseline.failed} tone="bad" />
                      <Count label="Total" value={baseline.total} />
                      <div className="flex flex-col">
                        <span className="text-2xs uppercase tracking-wide text-fg-subtle">Duration</span>
                        <span className="font-mono text-base font-semibold tabular-nums">
                          {formatDurationShort(baseline.durationMs)}
                        </span>
                      </div>
                      <p className="max-w-md text-2xs text-fg-subtle">
                        The baseline ran on the untouched workspace. Anything failing here is not a
                        regression.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-fg-muted">
                      No baseline run was recorded for this side, so regressions cannot be separated from
                      pre-existing failures.
                    </p>
                  )}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
