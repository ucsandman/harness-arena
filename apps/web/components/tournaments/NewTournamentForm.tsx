'use client';

import { useActionState, useState } from 'react';
import { createTournamentAction } from '@/app/tournaments/new/actions';
import {
  AREA,
  AgentField,
  ErrorList,
  Field,
  INPUT,
  SubmitRow,
  TargetFields,
  type AgentOption,
  type BenchmarkOption,
  type HarnessOption,
} from '@/components/arena/form-fields';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { NEW_ARENA_INITIAL } from '@/lib/arena-forms';

const MIN_ENTRANTS = 2;
const MAX_ENTRANTS = 16;

/**
 * Defines a bracket. Entrant rows submit as three parallel lists (source, label, commit); the server
 * mapping zips them by position and drops any row with no source, so removing a row never shifts a
 * label onto the wrong harness.
 */
export function NewTournamentForm({
  harnesses,
  benchmarks,
  agents,
}: {
  harnesses: readonly HarnessOption[];
  benchmarks: readonly BenchmarkOption[];
  agents: readonly AgentOption[];
}) {
  const [state, action, pending] = useActionState(createTournamentAction, NEW_ARENA_INITIAL);
  const [rows, setRows] = useState(4);

  return (
    <form action={action} className="flex flex-col gap-4">
      <ErrorList errors={state.errors} title="That bracket is not valid yet" />

      <Card>
        <CardHeader>
          <CardTitle>The tournament</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <Field label="Name" htmlFor="name" hint="Becomes part of the readable slug.">
            <input id="name" name="name" className={INPUT} placeholder="Claude Code harness cup" />
          </Field>
          <Field label="Description" htmlFor="description" hint="Optional.">
            <textarea id="description" name="description" rows={3} className={AREA} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent</CardTitle>
        </CardHeader>
        <CardBody>
          <AgentField agents={agents} />
        </CardBody>
      </Card>

      <TargetFields benchmarks={benchmarks} />

      <Card>
        <CardHeader>
          <CardTitle>Entrants</CardTitle>
          <span className="text-2xs text-fg-subtle">
            {MIN_ENTRANTS}–{MAX_ENTRANTS}; top seeds take byes when the count is not a power of two
          </span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <datalist id="tournament-harness-sources">
            <option value="vanilla" />
            {harnesses.map((harness) => (
              <option key={harness.slug} value={harness.source}>
                {harness.name}
              </option>
            ))}
          </datalist>

          {Array.from({ length: rows }, (_, index) => (
            <fieldset key={index} className="grid gap-3 sm:grid-cols-3">
              <legend className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
                Entrant {index + 1}
              </legend>
              <Field
                label="Source"
                htmlFor={`entrantSource-${index}`}
                hint="vanilla, a GitHub URL, or a path."
              >
                <input
                  id={`entrantSource-${index}`}
                  name="entrantSource"
                  list="tournament-harness-sources"
                  className={INPUT}
                  defaultValue={index === 0 ? 'vanilla' : ''}
                  placeholder="https://github.com/owner/harness"
                />
              </Field>
              <Field label="Label" htmlFor={`entrantLabel-${index}`} hint="Shown in the bracket.">
                <input id={`entrantLabel-${index}`} name="entrantLabel" className={INPUT} />
              </Field>
              <Field label="Commit" htmlFor={`entrantCommit-${index}`} hint="Optional 7-40 hex characters.">
                <input id={`entrantCommit-${index}`} name="entrantCommit" className={INPUT} />
              </Field>
            </fieldset>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRows((count) => Math.min(MAX_ENTRANTS, count + 1))}
              disabled={rows >= MAX_ENTRANTS}
              className="inline-flex h-7 items-center rounded-md border border-border-strong bg-surface px-2.5 text-xs font-medium text-fg hover:bg-bg-subtle disabled:opacity-50"
            >
              Add an entrant
            </button>
            <button
              type="button"
              onClick={() => setRows((count) => Math.max(MIN_ENTRANTS, count - 1))}
              disabled={rows <= MIN_ENTRANTS}
              className="inline-flex h-7 items-center rounded-md border border-border-strong bg-surface px-2.5 text-xs font-medium text-fg-muted hover:bg-bg-subtle disabled:opacity-50"
            >
              Remove the last row
            </button>
            <span className="text-2xs text-fg-subtle">{rows} row(s); blank rows are ignored.</span>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Visibility</CardTitle>
        </CardHeader>
        <CardBody>
          <Field label="Visibility" htmlFor="visibility">
            <select id="visibility" name="visibility" className={INPUT} defaultValue="public">
              <option value="private">private</option>
              <option value="unlisted">unlisted (reachable by link)</option>
              <option value="public">public (listed)</option>
            </select>
          </Field>
        </CardBody>
      </Card>

      <SubmitRow
        pending={pending}
        label="Build the bracket"
        note="Creating it seeds the entrants and writes every match slot. Nothing runs until a contributor plays a match."
      />
    </form>
  );
}
