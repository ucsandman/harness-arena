import type { RunRecord } from '@harness-arena/protocol';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/cn';
import { formatDuration, shortCommit } from '@/lib/format';
import { RunStatusBadge, SIDE_BORDER, SideChip } from './shared';

/** Who competed on one side: agent, model, harness, status, duration. */
export function RunHeader({ run, className }: { run: RunRecord; className?: string }) {
  const harness = run.harness;
  const unavailableCapabilities = Object.entries(run.agent.capabilities)
    .filter(([, status]) => status === 'unavailable')
    .map(([name]) => name);

  return (
    <div className={cn('rounded-card border bg-surface p-3.5', SIDE_BORDER[run.side], className)}>
      <div className="flex flex-wrap items-center gap-2">
        <SideChip side={run.side} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{run.label}</span>
        <RunStatusBadge status={run.status} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-2xs uppercase tracking-wide text-fg-subtle">Agent</dt>
          <dd className="truncate font-mono">
            {run.agent.id}
            {run.agent.version ? <span className="text-fg-subtle"> {run.agent.version}</span> : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-2xs uppercase tracking-wide text-fg-subtle">Model</dt>
          <dd className="truncate font-mono">{run.agent.model ?? 'n/a'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-2xs uppercase tracking-wide text-fg-subtle">Harness</dt>
          <dd className="truncate font-mono">
            {harness.name}
            {harness.commit ? <span className="text-fg-subtle"> @{shortCommit(harness.commit)}</span> : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-2xs uppercase tracking-wide text-fg-subtle">Duration</dt>
          <dd className="truncate font-mono tabular-nums">{formatDuration(run.durationMs)}</dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" mono>
          {harness.kind}
        </Badge>
        {harness.appliedFiles.length > 0 ? (
          <Tooltip label={`Applied to the workspace: ${harness.appliedFiles.join(', ')}`}>
            <Badge variant="neutral">{harness.appliedFiles.length} harness files</Badge>
          </Tooltip>
        ) : (
          <Badge variant="neutral">no harness files</Badge>
        )}
        {harness.executedCommands.length > 0 ? (
          <Tooltip label={`Commands run on your behalf: ${harness.executedCommands.join(' ; ')}`}>
            <Badge variant="warn">{harness.executedCommands.length} trusted commands</Badge>
          </Tooltip>
        ) : null}
        {unavailableCapabilities.length > 0 ? (
          <Tooltip label={`This CLI does not report: ${unavailableCapabilities.join(', ')}`}>
            <Badge variant="unavailable">{unavailableCapabilities.length} unreported signals</Badge>
          </Tooltip>
        ) : null}
        {run.error ? <Badge variant="danger">{run.error.code}</Badge> : null}
      </div>
    </div>
  );
}
