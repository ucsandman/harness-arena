import { calculated, emptyMetrics, observed, unavailable } from '@harness-arena/protocol';
import type { ArenaEvent, MetricKey, MetricValue, RunMetrics, RunStatus } from '@harness-arena/protocol';
import type { AdapterCapabilities, AdapterResult, ObservabilityStatus } from '@harness-arena/adapters';
import type { DiffStats } from './git.js';
import type { TestOutcome } from './ports.js';

/**
 * Turns one run's raw telemetry into the metric table. Two rules decide everything here:
 *
 *  - a number is only `observed` when the CLI itself reported it;
 *  - a metric the CLI cannot report is `unavailable` with a note, never a zero.
 */

export interface AggregateMetricsInput {
  /** events for THIS run only */
  events: readonly ArenaEvent[];
  adapterResult: AdapterResult | null;
  capabilities: AdapterCapabilities | null;
  diff: DiffStats | null;
  tests: { baseline: TestOutcome | null; post: TestOutcome | null };
  status: RunStatus;
  exitCode: number | null;
  durationMs: number | null;
  /** adapter id used in metric sources and notes, e.g. "codex" */
  agentId?: string;
}

function countType(events: readonly ArenaEvent[], type: ArenaEvent['type']): number {
  let n = 0;
  for (const e of events) if (e.type === type) n += 1;
  return n;
}

export function aggregateRunMetrics(input: AggregateMetricsInput): RunMetrics {
  const m = emptyMetrics();
  const agent = input.agentId ?? 'agent';
  const caps = input.capabilities;
  const usage = input.adapterResult?.usage ?? null;

  /** A count derived from events is only meaningful when the adapter can observe that thing. */
  const counted = (
    capability: ObservabilityStatus | undefined,
    value: number,
    what: string,
    source: string,
  ): MetricValue => {
    if (caps && capability === 'unavailable') return unavailable(what + ' is not reported by ' + agent);
    return calculated(value, source);
  };

  // ---- completion ------------------------------------------------------------------------------
  m.completion_status = input.adapterResult
    ? observed(input.status, agent + ':status')
    : calculated(input.status, 'core:run');
  m.exit_code =
    input.exitCode === null
      ? unavailable('the process did not report an exit code')
      : observed(input.exitCode, agent + ':exit');
  m.duration_ms =
    input.durationMs === null
      ? unavailable('the run never started')
      : calculated(input.durationMs, 'core:clock');

  // ---- usage reported by the CLI --------------------------------------------------------------
  const tokenKeys: Array<[MetricKey, keyof NonNullable<typeof usage>]> = [
    ['tokens_input', 'inputTokens'],
    ['tokens_output', 'outputTokens'],
    ['tokens_cache_read', 'cacheReadTokens'],
    ['tokens_cache_write', 'cacheWriteTokens'],
    ['tokens_total', 'totalTokens'],
  ];
  for (const [key, field] of tokenKeys) {
    const value = usage ? usage[field] : undefined;
    if (typeof value === 'number') m[key] = observed(value, agent + ':usage', { unit: 'tokens' });
    else if (caps && caps.tokens === 'unavailable')
      m[key] = unavailable('token usage is not reported by ' + agent);
    else m[key] = unavailable('the CLI reported no token usage for this run');
  }
  if (m.tokens_total.status === 'unavailable' && usage) {
    const parts = [
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
    ].filter((v): v is number => typeof v === 'number');
    if (parts.length > 0)
      m.tokens_total = calculated(
        parts.reduce((a, b) => a + b, 0),
        agent + ':usage',
        { unit: 'tokens', note: 'sum of the token fields the CLI reported' },
      );
  }
  if (usage && typeof usage.costUsd === 'number') {
    const note = caps?.notes.find((n) => /cost/i.test(n));
    m.cost_usd = observed(usage.costUsd, agent + ':usage', { unit: 'usd', ...(note ? { note } : {}) });
  } else if (caps && caps.cost === 'unavailable') {
    m.cost_usd = unavailable('cost is not reported by ' + agent);
  } else {
    m.cost_usd = unavailable('the CLI reported no cost for this run');
  }
  m.turns =
    typeof input.adapterResult?.turns === 'number'
      ? observed(input.adapterResult.turns, agent + ':turns')
      : unavailable(
          caps && caps.turns === 'unavailable'
            ? 'turns are not reported by ' + agent
            : 'the CLI reported no turn count',
        );

  // ---- counts derived from the event stream ----------------------------------------------------
  m.model_requests = counted(
    caps?.model,
    countType(input.events, 'model.request'),
    'model requests',
    'core:events',
  );
  m.tool_calls = counted(
    caps?.toolCalls,
    countType(input.events, 'tool.called'),
    'tool calls',
    'core:events',
  );
  m.commands_run = counted(
    caps?.commands,
    countType(input.events, 'command.started'),
    'commands',
    'core:events',
  );
  const inspected = new Set<string>();
  for (const e of input.events) if (e.type === 'file.read') inspected.add(e.payload.path);
  m.files_inspected = counted(caps?.fileReads, inspected.size, 'file reads', 'core:events');
  m.subagents_spawned = counted(
    caps?.subagents,
    countType(input.events, 'subagent.spawned'),
    'subagents',
    'core:events',
  );
  m.context_compactions = counted(
    caps?.contextCompaction,
    countType(input.events, 'context.compacted'),
    'context compaction',
    'core:events',
  );
  m.errors = calculated(countType(input.events, 'error'), 'core:events');
  m.human_interventions = calculated(countType(input.events, 'human.intervention'), 'core:events');

  // Retries: post-phase test runs that failed before the first passing one, plus explicit retry warnings.
  const postRuns = input.events.filter((e) => e.type === 'test.completed' && e.payload.phase === 'post');
  const firstPass = postRuns.findIndex((e) => e.type === 'test.completed' && e.payload.failed === 0);
  const failedBeforePass = (firstPass === -1 ? postRuns : postRuns.slice(0, firstPass)).filter(
    (e) => e.type === 'test.completed' && (e.payload.failed ?? 0) > 0,
  ).length;
  const retryWarnings = input.events.filter(
    (e) => e.type === 'warning' && /retry/i.test(e.payload.code ?? ''),
  ).length;
  m.retries = calculated(failedBeforePass + retryWarnings, 'core:events');

  // ---- git-derived change size ----------------------------------------------------------------
  if (input.diff) {
    m.files_changed = calculated(input.diff.files.length, 'core:git-diff');
    m.lines_added = calculated(
      input.diff.files.reduce((n, f) => n + f.linesAdded, 0),
      'core:git-diff',
      { unit: 'lines' },
    );
    m.lines_removed = calculated(
      input.diff.files.reduce((n, f) => n + f.linesRemoved, 0),
      'core:git-diff',
      { unit: 'lines' },
    );
  } else {
    const note = 'no diff was collected for this run';
    m.files_changed = unavailable(note);
    m.lines_added = unavailable(note);
    m.lines_removed = unavailable(note);
  }

  // ---- tests and regressions -------------------------------------------------------------------
  const post = input.tests.post;
  if (post) {
    m.tests_passed =
      post.passed === null
        ? unavailable('the test output could not be parsed')
        : calculated(post.passed, 'core:tests');
    m.tests_failed =
      post.failed === null
        ? unavailable('the test output could not be parsed')
        : calculated(post.failed, 'core:tests');
    m.tests_total =
      post.total === null
        ? unavailable('the test output could not be parsed')
        : calculated(post.total, 'core:tests');
  } else {
    const note = 'no test command was configured for this battle';
    m.tests_passed = unavailable(note);
    m.tests_failed = unavailable(note);
    m.tests_total = unavailable(note);
  }

  const baseline = input.tests.baseline;
  if (!post) {
    m.regressions = unavailable('no test command was configured for this battle');
  } else if (!baseline) {
    m.regressions = unavailable(
      'no baseline run: pre-existing failures cannot be told apart from regressions',
    );
  } else {
    const before = new Set(baseline.failingTests);
    const newFailures = post.failingTests.filter((t) => !before.has(t));
    m.regressions = calculated(newFailures.length, 'core:tests', {
      note: newFailures.length > 0 ? 'newly failing: ' + newFailures.slice(0, 5).join(', ') : undefined,
    });
  }

  return m;
}
