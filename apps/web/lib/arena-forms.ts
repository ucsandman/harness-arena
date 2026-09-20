import {
  createBountyRequestSchema,
  createChallengeRequestSchema,
  createTournamentRequestSchema,
  type CreateBountyRequest,
  type CreateChallengeRequest,
  type CreateTournamentRequest,
} from '@harness-arena/protocol';
import { describeIssues } from './issues';

/**
 * The /challenges/new, /tournaments/new and /bounties/new forms, turned into validated protocol
 * requests.
 *
 * This lives outside the action modules for the same two reasons as lib/new-battle.ts: a
 * `'use server'` file may only export async functions, and the mapping is worth testing without a
 * session. Nothing here touches the database; the actions do that with the request this produces.
 */

export interface NewArenaState {
  status: 'idle' | 'error' | 'created';
  errors: string[];
}

export const NEW_ARENA_INITIAL: NewArenaState = { status: 'idle', errors: [] };

export type Built<T> = { ok: true; request: T } | { ok: false; errors: string[] };

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, key: string): string | undefined {
  const value = text(form, key);
  return value.length > 0 ? value : undefined;
}

function list(form: FormData, key: string): string[] {
  return form.getAll(key).map((value) => (typeof value === 'string' ? value.trim() : ''));
}

function positiveInt(form: FormData, key: string): number | undefined {
  const raw = text(form, key);
  if (raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function ratio(form: FormData, key: string): number | undefined {
  const raw = text(form, key);
  if (raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A datetime-local value ("2026-10-01T12:00") as an ISO string; blank stays undefined. */
function isoDate(form: FormData, key: string): string | undefined {
  const raw = text(form, key);
  if (raw.length === 0) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function competitor(form: FormData, prefix: string): { label?: string; harness: { source: string; commit?: string } } {
  const label = optional(form, `${prefix}Label`);
  const commit = optional(form, `${prefix}Commit`);
  return {
    ...(label ? { label } : {}),
    harness: { source: text(form, `${prefix}Source`), ...(commit ? { commit } : {}) },
  };
}

/**
 * The shared target block. The benchmark select carries `<slug>:<versionId>` in one option value, so
 * the form never has to keep two fields in sync.
 */
function workTarget(form: FormData): Record<string, unknown> {
  if (text(form, 'targetKind') === 'benchmark') {
    const raw = text(form, 'benchmarkVersion');
    const separator = raw.indexOf(':');
    const slug = separator < 0 ? raw : raw.slice(0, separator);
    const versionId = separator < 0 ? '' : raw.slice(separator + 1);
    const taskId = optional(form, 'benchmarkTaskId');
    return { kind: 'benchmark', slug, versionId, ...(taskId ? { taskId } : {}) };
  }
  const title = optional(form, 'taskTitle');
  const testsCommand = optional(form, 'testsCommand');
  const ref = optional(form, 'repositoryRef');
  return {
    kind: 'task',
    ...(title ? { title } : {}),
    category: text(form, 'category') || 'overall',
    task: { kind: 'prompt', prompt: text(form, 'prompt') },
    repository: { source: text(form, 'repositorySource') || 'empty', ...(ref ? { ref } : {}) },
    evaluation: testsCommand ? { tests: { command: testsCommand } } : {},
  };
}

function agent(form: FormData): Record<string, unknown> {
  const model = optional(form, 'model');
  return { id: text(form, 'agent') || 'claude-code', ...(model ? { model } : {}) };
}

export function challengeFromForm(form: FormData): Built<CreateChallengeRequest> {
  const expiresAt = isoDate(form, 'expiresAt');
  const description = optional(form, 'description');
  const input = {
    title: text(form, 'title'),
    ...(description ? { description } : {}),
    sides: { a: competitor(form, 'a'), b: competitor(form, 'b') },
    agent: agent(form),
    target: workTarget(form),
    privacy: { upload: text(form, 'upload') || 'metrics' },
    visibility: text(form, 'visibility') || 'public',
    ratingEligible: form.get('ratingEligible') === 'on',
    ...(expiresAt ? { expiresAt } : {}),
  };
  const parsed = createChallengeRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: describeIssues(parsed.error).split('; ') };
  return { ok: true, request: parsed.data };
}

export function tournamentFromForm(form: FormData): Built<CreateTournamentRequest> {
  const sources = list(form, 'entrantSource');
  const labels = list(form, 'entrantLabel');
  const commits = list(form, 'entrantCommit');
  const entrants = sources
    .map((source, index) => ({ source, label: labels[index] ?? '', commit: commits[index] ?? '' }))
    .filter((entry) => entry.source.length > 0)
    .map((entry) => ({
      ...(entry.label ? { label: entry.label } : {}),
      harness: { source: entry.source, ...(entry.commit ? { commit: entry.commit } : {}) },
    }));

  const description = optional(form, 'description');
  const input = {
    name: text(form, 'name'),
    ...(description ? { description } : {}),
    format: 'single_elimination',
    agent: agent(form),
    target: workTarget(form),
    entrants,
    visibility: text(form, 'visibility') || 'public',
  };
  const parsed = createTournamentRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: describeIssues(parsed.error).split('; ') };
  return { ok: true, request: parsed.data };
}

export function bountyFromForm(form: FormData): Built<CreateBountyRequest> {
  const description = optional(form, 'description');
  const eligibility = optional(form, 'eligibility');
  const deadline = isoDate(form, 'deadline');
  const maxTokensRatio = ratio(form, 'maxTokensRatio');
  const maxCostRatio = ratio(form, 'maxCostRatio');
  const maxDurationRatio = ratio(form, 'maxDurationRatio');

  const input = {
    title: text(form, 'title'),
    ...(description ? { description } : {}),
    baseline: competitor(form, 'baseline'),
    agent: agent(form),
    target: workTarget(form),
    condition: {
      mustWin: text(form, 'mustWin') === 'majority' ? 'majority' : 'every',
      minBattles: positiveInt(form, 'minBattles') ?? 1,
      ...(maxTokensRatio === undefined ? {} : { maxTokensRatio }),
      ...(maxCostRatio === undefined ? {} : { maxCostRatio }),
      ...(maxDurationRatio === undefined ? {} : { maxDurationRatio }),
    },
    reward: {
      kind: text(form, 'rewardKind') === 'external' ? 'external' : 'reputation',
      description: text(form, 'rewardDescription'),
    },
    ...(eligibility ? { eligibility } : {}),
    ...(deadline ? { deadline } : {}),
  };
  const parsed = createBountyRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: describeIssues(parsed.error).split('; ') };
  return { ok: true, request: parsed.data };
}
