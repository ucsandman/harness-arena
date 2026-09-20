'use client';

import { useState } from 'react';
import { TASK_CATEGORIES } from '@harness-arena/protocol';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';

/**
 * The field blocks the three competitive forms share: a harness reference, an agent, and the work
 * target (a published pack version or an inline task). One module so /challenges/new,
 * /tournaments/new and /bounties/new cannot drift into three different spellings of the same input.
 *
 * Field names here are exactly the keys lib/arena-forms.ts reads.
 */

export const INPUT =
  'h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-xs text-fg placeholder:text-fg-subtle';
export const AREA =
  'w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-subtle';

export interface HarnessOption {
  slug: string;
  name: string;
  source: string;
}

export interface BenchmarkOption {
  slug: string;
  name: string;
  version: string;
  versionId: string;
  taskCount: number;
  battlesPerRun: number;
}

export interface AgentOption {
  id: string;
  label: string;
  vendor: string;
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
        {label}
      </label>
      {children}
      {hint ? <p className="text-2xs text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

export function ErrorList({ errors, title }: { errors: readonly string[]; title: string }) {
  if (errors.length === 0) return null;
  return (
    <div className="rounded-card border border-danger-border bg-danger-subtle px-4 py-3">
      <h2 className="text-sm font-semibold text-danger">{title}</h2>
      <ul className="mt-1 flex flex-col gap-1">
        {errors.map((error) => (
          <li key={error} className="font-mono text-2xs text-danger">
            {error}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One harness reference: a free-text source (the only thing the CLI resolves) plus a picker that
 * fills it from the catalogue, an optional label and an optional commit. The picker writes into the
 * same input rather than submitting a second field, so what is stored is always what is shown.
 */
export function HarnessField({
  prefix,
  legend,
  harnesses,
  defaultSource = '',
  defaultLabel = '',
  hint,
}: {
  prefix: string;
  legend: string;
  harnesses: readonly HarnessOption[];
  defaultSource?: string;
  defaultLabel?: string;
  hint?: string;
}) {
  const [source, setSource] = useState(defaultSource);
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-2xs font-medium uppercase tracking-wide text-fg-muted">{legend}</legend>
      <Field
        label="Source"
        htmlFor={`${prefix}Source`}
        hint={hint ?? 'vanilla (agent defaults), a GitHub URL, or a local path on the machine that runs it.'}
      >
        <input
          id={`${prefix}Source`}
          name={`${prefix}Source`}
          className={INPUT}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="https://github.com/owner/harness"
        />
      </Field>
      {harnesses.length > 0 ? (
        <Field label="Or pick a catalogued harness" htmlFor={`${prefix}Picker`}>
          <select
            id={`${prefix}Picker`}
            className={INPUT}
            value=""
            onChange={(event) => {
              if (event.target.value) setSource(event.target.value);
            }}
          >
            <option value="">(choose to fill the source above)</option>
            <option value="vanilla">vanilla — agent defaults, no harness files</option>
            {harnesses.map((harness) => (
              <option key={harness.slug} value={harness.source}>
                {harness.name} ({harness.slug})
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label" htmlFor={`${prefix}Label`} hint="Optional. Shown instead of the source.">
          <input
            id={`${prefix}Label`}
            name={`${prefix}Label`}
            className={INPUT}
            defaultValue={defaultLabel}
            placeholder="my harness"
          />
        </Field>
        <Field
          label="Commit"
          htmlFor={`${prefix}Commit`}
          hint="Optional 7-40 hex characters. A rated result needs one; without it the run takes whatever the branch says that day."
        >
          <input id={`${prefix}Commit`} name={`${prefix}Commit`} className={INPUT} placeholder="a1b2c3d" />
        </Field>
      </div>
    </fieldset>
  );
}

export function AgentField({
  agents,
  defaultAgent = 'claude-code',
}: {
  agents: readonly AgentOption[];
  defaultAgent?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Agent CLI" htmlFor="agent" hint="Both sides run the same agent.">
        <select id="agent" name="agent" defaultValue={defaultAgent} className={INPUT}>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label} ({agent.vendor})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model" htmlFor="model" hint="Passed to the CLI as-is. Blank uses its default.">
        <input id="model" name="model" className={INPUT} placeholder="opus-5" />
      </Field>
    </div>
  );
}

/** Benchmark pack (with an optional single task) or an inline task both sides receive verbatim. */
export function TargetFields({ benchmarks }: { benchmarks: readonly BenchmarkOption[] }) {
  const [kind, setKind] = useState<'benchmark' | 'task'>(benchmarks.length > 0 ? 'benchmark' : 'task');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Target</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-2">
          <legend className="text-2xs font-medium uppercase tracking-wide text-fg-muted">What to run</legend>
          <div className="flex flex-wrap gap-4">
            {(['benchmark', 'task'] as const).map((option) => (
              <label key={option} className="inline-flex items-center gap-1.5 text-xs">
                <input
                  type="radio"
                  name="targetKind"
                  value={option}
                  checked={kind === option}
                  onChange={() => setKind(option)}
                  disabled={option === 'benchmark' && benchmarks.length === 0}
                />
                {option === 'benchmark' ? 'Published benchmark pack' : 'Inline task'}
              </label>
            ))}
          </div>
          {benchmarks.length === 0 ? (
            <p className="text-2xs text-fg-subtle">
              No benchmark pack is published yet, so only an inline task is available.
            </p>
          ) : null}
        </fieldset>

        {kind === 'benchmark' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Pack version"
              htmlFor="benchmarkVersion"
              hint="The identity is the content hash, so this pins the exact tasks."
            >
              <select id="benchmarkVersion" name="benchmarkVersion" className={INPUT}>
                {benchmarks.map((pack) => (
                  <option key={pack.versionId} value={`${pack.slug}:${pack.versionId}`}>
                    {pack.name} v{pack.version} — {pack.taskCount} task(s), {pack.battlesPerRun} battle(s) per
                    run
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Single task id"
              htmlFor="benchmarkTaskId"
              hint="Optional. Blank runs the whole pack."
            >
              <input
                id="benchmarkTaskId"
                name="benchmarkTaskId"
                className={INPUT}
                placeholder="fix-null-deref"
              />
            </Field>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Task title" htmlFor="taskTitle" hint="Optional. Defaults to the first line.">
                <input id="taskTitle" name="taskTitle" className={INPUT} placeholder="Fix the parser" />
              </Field>
              <Field label="Category" htmlFor="category" hint="What this task actually measures.">
                <select id="category" name="category" className={INPUT} defaultValue="overall">
                  <option value="overall">overall</option>
                  {TASK_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Prompt" htmlFor="prompt" hint="Both sides receive this text verbatim.">
              <textarea
                id="prompt"
                name="prompt"
                rows={6}
                className={AREA}
                placeholder="Fix the failing test in src/auth/session.js and explain the root cause."
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Repository" htmlFor="repositorySource" hint="URL, path, or empty.">
                <input id="repositorySource" name="repositorySource" className={INPUT} defaultValue="empty" />
              </Field>
              <Field label="Ref" htmlFor="repositoryRef" hint="Branch, tag or commit.">
                <input id="repositoryRef" name="repositoryRef" className={INPUT} placeholder="main" />
              </Field>
              <Field label="Test command" htmlFor="testsCommand" hint="Optional correctness gate.">
                <input id="testsCommand" name="testsCommand" className={INPUT} placeholder="npm test" />
              </Field>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function SubmitRow({ pending, label, note }: { pending: boolean; label: string; note: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
      >
        {pending ? 'Saving…' : label}
      </button>
      <p className="text-2xs text-fg-subtle">{note}</p>
    </div>
  );
}
