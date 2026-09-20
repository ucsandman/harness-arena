import {
  battleRecordSchema,
  emptyMetrics,
  makeId,
  type BattleRecord,
  type BattleSpec,
  type CompetitorSpec,
  type EnvironmentInfo,
  type ResolvedTask,
  type RunRecord,
  type Side,
} from '@harness-arena/protocol';
import { classifyRepository, classifySource } from './sources';
import { WEB_ARENA_VERSION } from './version';

/**
 * A battle created from the web form has no results yet: it is a spec with a pending record, waiting
 * for `arena run --battle <id>` on the user's machine. The CLI replaces this record wholesale (agent
 * versions, environment, metrics, verdict) as soon as it starts, so everything unknown here is null
 * or `unavailable`, never a zero.
 */

function firstLine(value: string, max = 120): string {
  const line = value.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? value;
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function resolveTaskForSpec(spec: BattleSpec): ResolvedTask {
  if (spec.task.kind === 'issue') {
    const url = `https://github.com/${spec.task.repo}/issues/${spec.task.number}`;
    const instructions = spec.task.instructions?.trim();
    const prompt = [
      `Resolve GitHub issue ${url}.`,
      'The CLI replaces this text with the issue title and body when it runs the battle.',
      ...(instructions ? [instructions] : []),
    ].join('\n\n');
    return {
      title: spec.title ?? `${spec.task.repo}#${spec.task.number}`,
      prompt,
      source: { kind: 'issue', repo: spec.task.repo, number: spec.task.number, url },
    };
  }
  return {
    title: spec.title ?? spec.task.title ?? firstLine(spec.task.prompt),
    prompt: spec.task.prompt,
    source: { kind: 'prompt' },
  };
}

/** Placeholder environment: the machine that runs the battle records the real one. */
function placeholderEnvironment(now: Date): EnvironmentInfo {
  return {
    os: { platform: 'other', release: 'unknown', arch: 'unknown' },
    node: 'unknown',
    git: null,
    arenaVersion: WEB_ARENA_VERSION,
    ci: false,
    cpuCount: 0,
    memoryGb: 0,
    agents: {},
    sharedFlags: {},
    recordedAt: now.toISOString(),
  };
}

function pendingRun(side: Side, competitor: CompetitorSpec): RunRecord {
  const harness = classifySource(competitor.harness.source);
  return {
    id: makeId('run'),
    side,
    label: competitor.label ?? `${harness.name} on ${competitor.agent.id}`,
    status: 'pending',
    agent: {
      id: competitor.agent.id,
      version: null,
      model: competitor.agent.model ?? null,
      capabilities: {},
    },
    harness: {
      name: harness.name,
      source: competitor.harness.source,
      kind: harness.kind,
      commit: competitor.harness.commit ?? null,
      manifest: null,
      appliedFiles: [],
      executedCommands: [],
      skippedFiles: [],
    },
    startedAt: null,
    completedAt: null,
    durationMs: null,
    exitCode: null,
    metrics: emptyMetrics(),
    artifacts: { changedFiles: [] },
    error: null,
    eventCount: 0,
    invocation: null,
  };
}

export interface BuildPendingOptions {
  id?: string;
  now?: Date;
}

export function buildPendingRecord(spec: BattleSpec, opts: BuildPendingOptions = {}): BattleRecord {
  const now = opts.now ?? new Date();
  const repository = classifyRepository(spec.repository.source);
  const record: BattleRecord = {
    id: opts.id ?? makeId('battle'),
    protocolVersion: 1,
    arenaVersion: WEB_ARENA_VERSION,
    status: 'pending',
    spec,
    task: resolveTaskForSpec(spec),
    repository: {
      source: spec.repository.source,
      kind: repository.kind,
      commit: spec.repository.commit ?? null,
      ref: spec.repository.ref ?? null,
      dirty: null,
    },
    environment: placeholderEnvironment(now),
    runs: { a: pendingRun('a', spec.competitors.a), b: pendingRun('b', spec.competitors.b) },
    evaluation: null,
    verdict: null,
    insights: [],
    // a battle run on someone's own machine is self-reported, so it can never enter the verified pool
    verification: { kind: 'local', eligible: false, sandbox: null },
    demo: false,
    integrity: null,
    createdAt: now.toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
  };
  return battleRecordSchema.parse(record);
}
