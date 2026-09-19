import type { BattleRecord, Side } from '@harness-arena/protocol';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { formatNumber, formatUtcTime, shortCommit } from '@/lib/format';
import { SideChip } from './shared';

function Field({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className={cn('truncate text-xs', mono && 'font-mono tabular-nums')}>{value}</dd>
    </div>
  );
}

/** Everything needed to argue with the result: commits, versions, flags, and what was actually run. */
export function EnvironmentPanel({ record, className }: { record: BattleRecord; className?: string }) {
  const env = record.environment;
  const sides: Side[] = ['a', 'b'];

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Card>
        <CardHeader>
          <CardTitle>Machine and repository</CardTitle>
          <span className="text-2xs text-fg-muted">
            Recorded at {formatUtcTime(env.recordedAt)}. No hostname, username or environment values are kept.
          </span>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Field label="Platform" value={`${env.os.platform} ${env.os.release}`} />
            <Field label="Arch" value={env.os.arch} />
            <Field label="Node" value={env.node} />
            <Field label="Git" value={env.git ?? 'n/a'} />
            <Field label="Arena" value={env.arenaVersion} />
            <Field label="CPU cores" value={formatNumber(env.cpuCount)} />
            <Field label="Memory" value={`${formatNumber(env.memoryGb)} GB`} />
            <Field label="CI" value={env.ci ? 'yes' : 'no'} />
            <Field label="Repository" value={record.repository.source} />
            <Field label="Ref" value={record.repository.ref ?? 'n/a'} />
            <Field label="Commit" value={shortCommit(record.repository.commit, 12)} />
            <Field
              label="Working tree"
              value={record.repository.dirty === null ? 'n/a' : record.repository.dirty ? 'dirty' : 'clean'}
            />
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <Badge variant={record.verification.kind === 'cloud' ? 'accent' : 'neutral'}>
              {record.verification.kind} execution
            </Badge>
            <Badge variant={record.verification.eligible ? 'success' : 'unavailable'}>
              {record.verification.eligible ? 'verified pool eligible' : 'community pool only'}
            </Badge>
            <Badge variant="outline" mono>
              protocol v{record.protocolVersion}
            </Badge>
            {record.demo ? <Badge variant="demo">demo data</Badge> : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent detection and fairness flags</CardTitle>
          <span className="text-2xs text-fg-muted">
            Flags Arena added to both sides so the harness is the only intended difference.
          </span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            {Object.entries(env.agents).map(([agentId, info]) => (
              <div key={agentId} className="rounded-md border border-border bg-bg-subtle p-2.5">
                <dt className="font-mono text-xs">{agentId}</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-fg-muted">
                  <span className="font-mono">{info.version ?? 'version unknown'}</span>
                  <Badge
                    variant={
                      info.userConfigIsolated === true
                        ? 'success'
                        : info.userConfigIsolated === false
                          ? 'warn'
                          : 'unavailable'
                    }
                  >
                    {info.userConfigIsolated === true
                      ? 'user config excluded'
                      : info.userConfigIsolated === false
                        ? 'user config could not be excluded'
                        : 'isolation unknown'}
                  </Badge>
                </dd>
              </div>
            ))}
          </dl>

          {Object.keys(env.sharedFlags).length > 0 ? (
            <div>
              <h4 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">Shared flags</h4>
              <ul className="mt-1.5 flex flex-col gap-1">
                {Object.entries(env.sharedFlags).map(([agentId, flags]) => (
                  <li key={agentId} className="font-mono text-2xs text-fg-muted">
                    <span className="text-fg">{agentId}</span> {flags.join(' ')}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        {sides.map((side) => {
          const run = record.runs[side];
          const invocation = run.invocation;
          return (
            <Card key={side}>
              <CardHeader>
                <span className="flex min-w-0 items-center gap-2">
                  <SideChip side={side} />
                  <CardTitle className="truncate">What ran</CardTitle>
                </span>
              </CardHeader>
              <CardBody>
                {invocation ? (
                  <div className="flex flex-col gap-2">
                    <pre className="overflow-x-auto rounded-md border border-border bg-code-bg p-2.5 font-mono text-2xs leading-relaxed text-code-fg">
                      <code>{[invocation.command, ...invocation.args].join(' ')}</code>
                    </pre>
                    <p className="text-2xs text-fg-subtle">
                      The task prompt went in on stdin, so it never appears in the argument list.
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-2xs text-fg-subtle">Env keys added:</span>
                      {invocation.envKeys.length === 0 ? (
                        <Badge variant="neutral">none</Badge>
                      ) : (
                        invocation.envKeys.map((key) => (
                          <Badge key={key} variant="outline" mono>
                            {key}
                          </Badge>
                        ))
                      )}
                    </div>
                    <p className="text-2xs text-fg-subtle">
                      Key names only. Values are never recorded or uploaded.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-fg-muted">No invocation was recorded for this side.</p>
                )}

                {run.harness.appliedFiles.length > 0 ? (
                  <div className="mt-3">
                    <h4 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                      Harness files applied
                    </h4>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {run.harness.appliedFiles.map((file) => (
                        <li key={file} className="truncate font-mono text-2xs text-fg-muted">
                          {file}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
