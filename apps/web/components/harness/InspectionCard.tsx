import { Check, Minus } from 'lucide-react';
import type { HarnessInspection } from '@harness-arena/protocol';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { shortCommit } from '@/lib/format';

const STATUS_VARIANT: Record<HarnessInspection['compatibility']['status'], BadgeVariant> = {
  ready: 'success',
  partial: 'warn',
  unknown: 'neutral',
  incompatible: 'danger',
};

const FRAMEWORK_LABEL: Record<HarnessInspection['framework'], string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  opencode: 'OpenCode',
  multi: 'multi-agent',
  unknown: 'unrecognised',
};

function FeatureRow({ feature }: { feature: HarnessInspection['features'][number] }) {
  return (
    <li className="flex items-start gap-2 py-1.5">
      <span className={feature.detected ? 'mt-0.5 text-success' : 'mt-0.5 text-fg-subtle'} aria-hidden="true">
        {feature.detected ? <Check size={14} /> : <Minus size={14} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[0.8125rem] font-medium">{feature.label}</span>
          {feature.count !== undefined ? (
            <Badge variant="outline" mono>
              {feature.count}
            </Badge>
          ) : null}
          <span className="sr-only">{feature.detected ? 'detected' : 'not present'}</span>
        </span>
        {feature.paths.length > 0 ? (
          <span className="mt-0.5 block truncate font-mono text-2xs text-fg-subtle">
            {feature.paths.slice(0, 3).join(', ')}
            {feature.paths.length > 3 ? ` +${feature.paths.length - 3} more` : ''}
          </span>
        ) : null}
        {feature.note ? <span className="mt-0.5 block text-2xs text-fg-subtle">{feature.note}</span> : null}
      </span>
    </li>
  );
}

/**
 * What Arena found in a harness repository, read over the GitHub API. Nothing here was cloned and
 * nothing was executed: the install commands are shown so a human can decide before trusting them.
 */
export function InspectionCard({
  inspection,
  title,
  sourceUrl,
}: {
  inspection: HarnessInspection;
  title: string;
  sourceUrl: string | null;
}) {
  const detected = inspection.features.filter((feature) => feature.detected);
  const missing = inspection.features.filter((feature) => !feature.detected);
  const compatibility = inspection.compatibility;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Detected {FRAMEWORK_LABEL[inspection.framework]} harness
          {inspection.framework === 'unknown' ? ' (no agent config files found)' : ''}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_VARIANT[compatibility.status]}>{compatibility.status}</Badge>
          {compatibility.status === 'ready' ? <Badge variant="success">Ready to battle</Badge> : null}
        </div>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-muted">
          <span className="font-medium text-fg">{title}</span>
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline"
            >
              {sourceUrl}
            </a>
          ) : null}
          <span className="font-mono">commit {shortCommit(inspection.commit)}</span>
          <span className="font-mono">{inspection.fileCount} files listed</span>
          {inspection.truncated ? <Badge variant="warn">listing truncated</Badge> : null}
          {inspection.agents.length > 0 ? (
            <span className="font-mono">agents: {inspection.agents.join(', ')}</span>
          ) : null}
        </div>

        {compatibility.reasons.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-card border border-border bg-bg-subtle px-3 py-2">
            {compatibility.reasons.map((reason) => (
              <li key={reason} className="text-2xs text-fg-muted">
                {reason}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="grid gap-x-6 sm:grid-cols-2">
          <div>
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Found ({detected.length})
            </h3>
            <ul className="divide-y divide-border">
              {detected.length > 0 ? (
                detected.map((feature) => <FeatureRow key={feature.id} feature={feature} />)
              ) : (
                <li className="py-1.5 text-2xs text-fg-subtle">Nothing a harness protocol recognises.</li>
              )}
            </ul>
          </div>
          <div>
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Not present ({missing.length})
            </h3>
            <ul className="divide-y divide-border">
              {missing.map((feature) => (
                <FeatureRow key={feature.id} feature={feature} />
              ))}
            </ul>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">arena.yaml</h3>
            {inspection.manifest.found ? (
              <>
                <p className="text-[0.8125rem]">
                  <span className="font-mono text-2xs">{inspection.manifest.path}</span>{' '}
                  {inspection.manifest.valid ? (
                    <Badge variant="success">valid</Badge>
                  ) : (
                    <Badge variant="danger">invalid</Badge>
                  )}
                </p>
                {inspection.manifest.manifest ? (
                  <p className="text-2xs text-fg-muted">
                    {inspection.manifest.manifest.name}
                    {inspection.manifest.manifest.version ? ` v${inspection.manifest.manifest.version}` : ''}
                    {inspection.manifest.manifest.description
                      ? ` — ${inspection.manifest.manifest.description}`
                      : ''}
                  </p>
                ) : null}
                {inspection.manifest.errors.map((error) => (
                  <p key={error} className="font-mono text-2xs text-danger">
                    {error}
                  </p>
                ))}
              </>
            ) : (
              <p className="text-2xs text-fg-muted">
                No manifest. Arena auto-detects the standard config files instead.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Files applied to the workspace
            </h3>
            {inspection.applyFiles.length > 0 ? (
              <p className="font-mono text-2xs text-fg-muted">{inspection.applyFiles.join(', ')}</p>
            ) : (
              <p className="text-2xs text-fg-muted">None detected.</p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            Install commands Arena would run
          </h3>
          <p className="text-2xs text-fg-muted">
            Runtime <span className="font-mono">{inspection.install.runtime}</span>, package manager{' '}
            <span className="font-mono">{inspection.install.packageManager}</span>. Commands only ever run on
            your machine, and only after you trust the harness.
          </p>
          {inspection.install.commands.length > 0 ? (
            <CodeBlock terminal code={inspection.install.commands.join('\n')} />
          ) : (
            <p className="text-2xs text-fg-subtle">None declared: nothing would be executed.</p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
