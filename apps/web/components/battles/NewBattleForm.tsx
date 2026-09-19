'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Download, Terminal } from 'lucide-react';
import { RATING_CATEGORIES, privacyExclusionSchema } from '@harness-arena/protocol';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { AGENT_OPTIONS } from '@/lib/agents';
import { BRAND } from '@/lib/brand';
import { createBattleSpecAction } from '@/app/battles/new/actions';
import { NEW_BATTLE_INITIAL, type NewBattleState } from '@/lib/new-battle';

const INPUT =
  'h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-xs text-fg placeholder:text-fg-subtle';
const AREA =
  'w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-subtle';

function Field({
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

function SideFields({ side }: { side: 'A' | 'B' }) {
  const suffix = side;
  const defaultAgent = 'claude-code';
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            Side {side}
            <Badge variant={side === 'A' ? 'side-a' : 'side-b'} mono>
              {side}
            </Badge>
          </span>
        </CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <Field
          label="Label"
          htmlFor={`label${suffix}`}
          hint="Shown on the report. Defaults to the harness name."
        >
          <input id={`label${suffix}`} name={`label${suffix}`} className={INPUT} placeholder="my harness" />
        </Field>
        <Field label="Agent CLI" htmlFor={`agent${suffix}`}>
          <select id={`agent${suffix}`} name={`agent${suffix}`} defaultValue={defaultAgent} className={INPUT}>
            {AGENT_OPTIONS.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label} ({agent.vendor})
              </option>
            ))}
          </select>
        </Field>
        <ul className="flex flex-col gap-1">
          {AGENT_OPTIONS.map((agent) => (
            <li key={agent.id} className="text-2xs text-fg-subtle">
              <span className="font-mono text-fg-muted">{agent.id}</span> — {agent.note}
            </li>
          ))}
        </ul>
        <Field
          label="Model"
          htmlFor={`model${suffix}`}
          hint="Passed to the CLI as-is. Blank uses its default."
        >
          <input id={`model${suffix}`} name={`model${suffix}`} className={INPUT} placeholder="opus-5" />
        </Field>
        <Field
          label="Harness"
          htmlFor={`harness${suffix}`}
          hint="vanilla (agent defaults), a GitHub URL, or a local path on the machine that runs the battle."
        >
          <input
            id={`harness${suffix}`}
            name={`harness${suffix}`}
            className={INPUT}
            defaultValue={side === 'A' ? 'vanilla' : ''}
            placeholder="https://github.com/owner/harness"
          />
        </Field>
      </CardBody>
    </Card>
  );
}

function Created({ state }: { state: NewBattleState }) {
  const id = state.battleId ?? '';
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-1.5">
            <Terminal size={14} aria-hidden="true" />
            Spec saved. This battle runs on your machine.
          </span>
        </CardTitle>
        <Badge variant="neutral" mono>
          {id}
        </Badge>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-[0.8125rem] text-fg-muted">
          Arena never pays for model usage and never holds provider credentials, so nothing starts here. Run
          the spec with your own authenticated CLIs:
        </p>
        <CodeBlock terminal code={`${BRAND.cli.bin} login\n${BRAND.cli.bin} run --battle ${id}`} />
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/battles/${id}`}
            className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-accent-fg hover:bg-accent-hover"
          >
            Open the battle page
          </Link>
          <a
            href={`/api/v1/battles/${id}?format=json`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-xs font-medium text-fg hover:bg-bg-subtle"
          >
            <Download size={13} aria-hidden="true" />
            Download battle.json
          </a>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Builds a BattleSpec and stores it as a pending battle. There is deliberately no Run button: the
 * battle executes on the user's machine through their own CLIs.
 */
export function NewBattleForm() {
  const [state, action, pending] = useActionState(createBattleSpecAction, NEW_BATTLE_INITIAL);
  const [taskKind, setTaskKind] = useState<'prompt' | 'issue'>('prompt');

  if (state.status === 'created') return <Created state={state} />;

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.errors.length > 0 ? (
        <div className="rounded-card border border-danger-border bg-danger-subtle px-4 py-3">
          <h2 className="text-sm font-semibold text-danger">That spec is not valid yet</h2>
          <ul className="mt-1 flex flex-col gap-1">
            {state.errors.map((error) => (
              <li key={error} className="font-mono text-2xs text-danger">
                {error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Task</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <Field label="Title" htmlFor="title" hint="Optional. Defaults to the first line of the prompt.">
            <input id="title" name="title" className={INPUT} placeholder="Fix the session-expiry bug" />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Source</legend>
            <div className="flex flex-wrap gap-4">
              {(['prompt', 'issue'] as const).map((kind) => (
                <label key={kind} className="inline-flex items-center gap-1.5 text-xs">
                  <input
                    type="radio"
                    name="taskKind"
                    value={kind}
                    checked={taskKind === kind}
                    onChange={() => setTaskKind(kind)}
                  />
                  {kind === 'prompt' ? 'Prompt' : 'GitHub issue'}
                </label>
              ))}
            </div>
          </fieldset>

          {taskKind === 'prompt' ? (
            <Field label="Prompt" htmlFor="prompt" hint="Both sides receive this text verbatim.">
              <textarea
                id="prompt"
                name="prompt"
                rows={6}
                className={AREA}
                placeholder="Fix the failing test in src/auth/session.js and explain the root cause."
              />
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Repository" htmlFor="issueRepo" hint="owner/name">
                <input id="issueRepo" name="issueRepo" className={INPUT} placeholder="vercel/next.js" />
              </Field>
              <Field label="Issue number" htmlFor="issueNumber">
                <input
                  id="issueNumber"
                  name="issueNumber"
                  className={INPUT}
                  inputMode="numeric"
                  placeholder="1234"
                />
              </Field>
              <div className="sm:col-span-2">
                <Field
                  label="Extra instructions"
                  htmlFor="issueInstructions"
                  hint="Appended after the issue body. The CLI fetches the issue text when it runs."
                >
                  <textarea id="issueInstructions" name="issueInstructions" rows={3} className={AREA} />
                </Field>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Repository</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Source"
            htmlFor="repositorySource"
            hint="GitHub URL, git URL, a local path, or empty for a greenfield task."
          >
            <input id="repositorySource" name="repositorySource" className={INPUT} defaultValue="empty" />
          </Field>
          <Field
            label="Ref"
            htmlFor="repositoryRef"
            hint="Branch, tag or commit. Blank uses the default branch."
          >
            <input id="repositoryRef" name="repositoryRef" className={INPUT} placeholder="main" />
          </Field>
        </CardBody>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <SideFields side="A" />
        <SideFields side="B" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Limits and evaluation</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label="Timeout (minutes)" htmlFor="timeoutMinutes">
            <input
              id="timeoutMinutes"
              name="timeoutMinutes"
              className={INPUT}
              inputMode="numeric"
              defaultValue="20"
            />
          </Field>
          <Field
            label="Max turns"
            htmlFor="maxTurns"
            hint="Optional; only the CLIs that support it enforce it."
          >
            <input id="maxTurns" name="maxTurns" className={INPUT} inputMode="numeric" placeholder="40" />
          </Field>
          <Field
            label="Test command"
            htmlFor="testsCommand"
            hint="Run once before the battle for a baseline, then after each side."
          >
            <input id="testsCommand" name="testsCommand" className={INPUT} placeholder="npm test" />
          </Field>
          <Field label="Category" htmlFor="category" hint="Used for the per-category ratings.">
            <select id="category" name="category" className={INPUT} defaultValue="">
              <option value="">(none)</option>
              {RATING_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="Assertions (JSON array)"
              htmlFor="assertions"
              hint='Optional deterministic checks, e.g. [{"type":"file-exists","path":"README.md"}]'
            >
              <textarea id="assertions" name="assertions" rows={3} className={AREA} placeholder="[]" />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Privacy and visibility</CardTitle>
          <Link href="/privacy" className="text-2xs text-accent hover:underline">
            What an upload contains
          </Link>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Upload level"
              htmlFor="upload"
              hint="metrics sends the record and verdict only; none keeps every byte on your machine, so this page would stay pending."
            >
              <select id="upload" name="upload" className={INPUT} defaultValue="metrics">
                <option value="none">none (local only)</option>
                <option value="metrics">metrics (record, verdict, environment)</option>
                <option value="events">events (metrics + the event stream)</option>
                <option value="full">full (events + diff and final response)</option>
              </select>
            </Field>
            <Field label="Visibility" htmlFor="visibility">
              <select id="visibility" name="visibility" className={INPUT} defaultValue="private">
                <option value="private">private (only you)</option>
                <option value="unlisted">unlisted (anyone with the link)</option>
                <option value="public">public (listed and in ratings)</option>
              </select>
            </Field>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Exclusions</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {privacyExclusionSchema.options.map((exclusion) => (
                <label key={exclusion} className="inline-flex items-center gap-1.5 text-xs">
                  <input type="checkbox" name="exclude" value={exclusion} />
                  <span className="font-mono text-2xs">{exclusion}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="inline-flex items-center gap-1.5 text-xs">
            <input type="checkbox" name="parallel" />
            Run both sides at the same time (faster, less fair on a shared CPU)
          </label>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          {pending ? 'Saving the spec…' : 'Save battle spec'}
        </button>
        <p className="text-2xs text-fg-subtle">
          Saving stores the spec. Running it is one command on your machine.
        </p>
      </div>
    </form>
  );
}
