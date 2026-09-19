import {
  BATTLE_SPEC_VERSION,
  battleSpecSchema,
  type BattleSpec,
  type BattleSpecInput,
  type PrivacyExclusion,
} from '@harness-arena/protocol';
import { describeIssues } from './issues';

/**
 * The /battles/new form, turned into a validated BattleSpec.
 *
 * This lives outside the action module for two reasons: a `'use server'` file may only export async
 * functions (a constant exported from one arrives as `undefined` in a client component), and the
 * mapping is worth testing without a session.
 */

export interface NewBattleState {
  status: 'idle' | 'error' | 'created';
  errors: string[];
  battleId?: string;
  battleUrl?: string;
  title?: string;
}

export const NEW_BATTLE_INITIAL: NewBattleState = { status: 'idle', errors: [] };

type EvaluationInput = NonNullable<BattleSpecInput['evaluation']>;
type AssertionsInput = NonNullable<EvaluationInput['assertions']>;

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, key: string): string | undefined {
  const value = text(form, key);
  return value.length > 0 ? value : undefined;
}

function positiveInt(form: FormData, key: string): number | undefined {
  const raw = text(form, key);
  if (raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export type SpecFromForm = { ok: true; spec: BattleSpec } | { ok: false; errors: string[] };

export function specFromForm(form: FormData): SpecFromForm {
  const taskKind = text(form, 'taskKind') === 'issue' ? 'issue' : 'prompt';
  const errors: string[] = [];

  let assertions: unknown[] = [];
  const assertionsRaw = text(form, 'assertions');
  if (assertionsRaw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(assertionsRaw);
      if (!Array.isArray(parsed)) errors.push('Assertions must be a JSON array.');
      else assertions = parsed;
    } catch {
      errors.push('Assertions is not valid JSON. See /docs/cli for the assertion shape.');
    }
  }

  const issueNumber = positiveInt(form, 'issueNumber');
  if (taskKind === 'issue' && issueNumber === undefined) errors.push('An issue number is required.');
  if (errors.length > 0) return { ok: false, errors };

  const timeoutMinutes = positiveInt(form, 'timeoutMinutes') ?? 20;
  const maxTurns = positiveInt(form, 'maxTurns');
  const exclude = form.getAll('exclude').filter((value): value is string => typeof value === 'string');
  const testsCommand = optional(form, 'testsCommand');

  const input: BattleSpecInput = {
    version: BATTLE_SPEC_VERSION,
    ...(optional(form, 'title') ? { title: optional(form, 'title') } : {}),
    task:
      taskKind === 'issue'
        ? {
            kind: 'issue',
            repo: text(form, 'issueRepo'),
            number: issueNumber ?? 0,
            ...(optional(form, 'issueInstructions')
              ? { instructions: optional(form, 'issueInstructions') }
              : {}),
          }
        : { kind: 'prompt', prompt: text(form, 'prompt') },
    repository: {
      source: text(form, 'repositorySource') || 'empty',
      ...(optional(form, 'repositoryRef') ? { ref: optional(form, 'repositoryRef') } : {}),
    },
    competitors: {
      a: {
        ...(optional(form, 'labelA') ? { label: optional(form, 'labelA') } : {}),
        agent: {
          id: text(form, 'agentA') || 'claude-code',
          ...(optional(form, 'modelA') ? { model: optional(form, 'modelA') } : {}),
        },
        harness: { source: text(form, 'harnessA') || 'vanilla' },
      },
      b: {
        ...(optional(form, 'labelB') ? { label: optional(form, 'labelB') } : {}),
        agent: {
          id: text(form, 'agentB') || 'claude-code',
          ...(optional(form, 'modelB') ? { model: optional(form, 'modelB') } : {}),
        },
        harness: { source: text(form, 'harnessB') || 'vanilla' },
      },
    },
    limits: {
      timeoutMs: timeoutMinutes * 60_000,
      ...(maxTurns === undefined ? {} : { maxTurns }),
    },
    evaluation: {
      ...(testsCommand ? { tests: { command: testsCommand } } : {}),
      // validated by battleSpecSchema immediately below; the cast only satisfies the input type
      assertions: assertions as AssertionsInput,
    },
    privacy: {
      upload: (text(form, 'upload') || 'none') as 'none' | 'metrics' | 'events' | 'full',
      exclude: exclude as PrivacyExclusion[],
    },
    visibility: (text(form, 'visibility') || 'private') as 'private' | 'unlisted' | 'public',
    ...(optional(form, 'category') ? { category: optional(form, 'category') } : {}),
    parallel: form.get('parallel') === 'on',
  };

  const parsed = battleSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: describeIssues(parsed.error).split('; ') };
  return { ok: true, spec: parsed.data };
}
