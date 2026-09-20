'use client';

import { useActionState } from 'react';
import { createChallengeAction } from '@/app/challenges/new/actions';
import {
  AREA,
  AgentField,
  ErrorList,
  Field,
  HarnessField,
  INPUT,
  SubmitRow,
  TargetFields,
  type AgentOption,
  type BenchmarkOption,
  type HarnessOption,
} from '@/components/arena/form-fields';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { NEW_ARENA_INITIAL } from '@/lib/arena-forms';

/**
 * Defines a challenge. There is deliberately no Run button: Arena hosts no runner, so the only thing
 * this form produces is a definition that somebody else executes locally with the CLI.
 */
export function NewChallengeForm({
  harnesses,
  benchmarks,
  agents,
  defaultA,
  defaultB,
}: {
  harnesses: readonly HarnessOption[];
  benchmarks: readonly BenchmarkOption[];
  agents: readonly AgentOption[];
  defaultA: string;
  defaultB: string;
}) {
  const [state, action, pending] = useActionState(createChallengeAction, NEW_ARENA_INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4">
      <ErrorList errors={state.errors} title="That challenge is not valid yet" />

      <Card>
        <CardHeader>
          <CardTitle>What you are asking</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <Field label="Title" htmlFor="title" hint="What the matchup is meant to settle.">
            <input
              id="title"
              name="title"
              className={INPUT}
              placeholder="superclaude vs vanilla on the widget parser"
            />
          </Field>
          <Field label="Description" htmlFor="description" hint="Optional context for whoever accepts.">
            <textarea id="description" name="description" rows={3} className={AREA} />
          </Field>
        </CardBody>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Side A</CardTitle>
          </CardHeader>
          <CardBody>
            <HarnessField
              prefix="a"
              legend="Harness A"
              harnesses={harnesses}
              defaultSource={defaultA}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Side B</CardTitle>
          </CardHeader>
          <CardBody>
            <HarnessField
              prefix="b"
              legend="Harness B"
              harnesses={harnesses}
              defaultSource={defaultB}
            />
          </CardBody>
        </Card>
      </div>

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
          <CardTitle>Rules, privacy and visibility</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Upload level"
              htmlFor="upload"
              hint="What the accepter uploads. metrics sends the record and verdict only."
            >
              <select id="upload" name="upload" className={INPUT} defaultValue="metrics">
                <option value="none">none (local only)</option>
                <option value="metrics">metrics (record, verdict, environment)</option>
                <option value="events">events (metrics + the event stream)</option>
                <option value="full">full (events + diff and final response)</option>
              </select>
            </Field>
            <Field label="Visibility" htmlFor="visibility">
              <select id="visibility" name="visibility" className={INPUT} defaultValue="public">
                <option value="private">private (you and the accepter)</option>
                <option value="unlisted">unlisted (anyone with the link)</option>
                <option value="public">public (listed)</option>
              </select>
            </Field>
            <Field
              label="Deadline"
              htmlFor="expiresAt"
              hint="Optional. Past it, the challenge expires."
            >
              <input id="expiresAt" name="expiresAt" type="datetime-local" className={INPUT} />
            </Field>
          </div>
          <label className="inline-flex items-start gap-1.5 text-xs">
            <input type="checkbox" name="ratingEligible" defaultChecked className="mt-0.5" />
            <span>
              A decided result may move community ratings.
              <span className="block text-2xs text-fg-subtle">
                Permission, not a guarantee: a linked battle still has to be public, completed, not a demo,
                and past the integrity checks.
              </span>
            </span>
          </label>
        </CardBody>
      </Card>

      <SubmitRow
        pending={pending}
        label="Create the challenge"
        note="Creating it stores the definition. Nothing runs until somebody accepts it on their own machine."
      />
    </form>
  );
}
