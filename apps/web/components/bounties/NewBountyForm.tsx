'use client';

import { useActionState } from 'react';
import { createBountyAction } from '@/app/bounties/new/actions';
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
 * Posts a bounty. Every ratio field is optional: a condition that names a metric nobody reports is
 * unmeetable, and the evaluator treats an unevaluable check as not met rather than as a pass.
 */
export function NewBountyForm({
  harnesses,
  benchmarks,
  agents,
}: {
  harnesses: readonly HarnessOption[];
  benchmarks: readonly BenchmarkOption[];
  agents: readonly AgentOption[];
}) {
  const [state, action, pending] = useActionState(createBountyAction, NEW_ARENA_INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4">
      <ErrorList errors={state.errors} title="That bounty is not valid yet" />

      <Card>
        <CardHeader>
          <CardTitle>What you are asking for</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <Field label="Title" htmlFor="title">
            <input
              id="title"
              name="title"
              className={INPUT}
              placeholder="Beat vanilla on the parser suite with 20% fewer tokens"
            />
          </Field>
          <Field label="Description" htmlFor="description" hint="Optional context for a submitter.">
            <textarea id="description" name="description" rows={4} className={AREA} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Baseline</CardTitle>
          <span className="text-2xs text-fg-subtle">the harness a submission has to beat</span>
        </CardHeader>
        <CardBody>
          <HarnessField
            prefix="baseline"
            legend="Baseline harness"
            harnesses={harnesses}
            defaultSource="vanilla"
          />
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
          <CardTitle>Success condition</CardTitle>
          <span className="text-2xs text-fg-subtle">arithmetic, not judgement</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Must win" htmlFor="mustWin">
              <select id="mustWin" name="mustWin" className={INPUT} defaultValue="every">
                <option value="every">every linked battle</option>
                <option value="majority">more than half of the decided battles</option>
              </select>
            </Field>
            <Field
              label="Minimum battles"
              htmlFor="minBattles"
              hint="One trial on one task is an anecdote."
            >
              <input
                id="minBattles"
                name="minBattles"
                className={INPUT}
                inputMode="numeric"
                defaultValue="1"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Max tokens ratio"
              htmlFor="maxTokensRatio"
              hint="0.8 = at most 80% of baseline. Blank means no token requirement."
            >
              <input id="maxTokensRatio" name="maxTokensRatio" className={INPUT} placeholder="0.8" />
            </Field>
            <Field label="Max cost ratio" htmlFor="maxCostRatio" hint="Only some CLIs report cost.">
              <input id="maxCostRatio" name="maxCostRatio" className={INPUT} placeholder="0.9" />
            </Field>
            <Field label="Max duration ratio" htmlFor="maxDurationRatio" hint="Wall clock, per battle.">
              <input id="maxDurationRatio" name="maxDurationRatio" className={INPUT} placeholder="1" />
            </Field>
          </div>
          <p className="text-2xs text-fg-subtle">
            The worst battle decides: a ratio check passes only when it holds on every comparable battle. A
            metric nobody reports on both sides makes the check not met, with the count.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reward</CardTitle>
          <span className="text-2xs text-fg-subtle">Arena moves no money</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind" htmlFor="rewardKind">
              <select id="rewardKind" name="rewardKind" className={INPUT} defaultValue="reputation">
                <option value="reputation">reputation (a public statement, nothing changes hands)</option>
                <option value="external">external (you settle it elsewhere, on your own terms)</option>
              </select>
            </Field>
            <Field label="Deadline" htmlFor="deadline" hint="Optional.">
              <input id="deadline" name="deadline" type="datetime-local" className={INPUT} />
            </Field>
          </div>
          <Field
            label="Reward description"
            htmlFor="rewardDescription"
            hint="What the winner actually gets, in your own words."
          >
            <textarea id="rewardDescription" name="rewardDescription" rows={3} className={AREA} />
          </Field>
          <Field label="Eligibility" htmlFor="eligibility" hint="Optional restrictions on who may enter.">
            <textarea id="eligibility" name="eligibility" rows={2} className={AREA} />
          </Field>
          <p className="text-2xs text-fg-subtle">
            Arena holds no funds, escrows nothing and is not a party to any reward. Posting a bounty stores
            the definition and nothing else.
          </p>
        </CardBody>
      </Card>

      <SubmitRow
        pending={pending}
        label="Post the bounty"
        note="Submitters run the work on their own machines and upload the battles against their submission."
      />
    </form>
  );
}
