import type {
  ArenaEvent,
  BattleRecord,
  Insight,
  MetricKey,
  MetricValue,
  Side,
} from '@harness-arena/protocol';

/**
 * Observations the telemetry actually supports. Nothing here guesses: an insight is emitted only
 * when both sides have a comparable value, and every insight names the metrics and event sequence
 * numbers that back it so the report can link to the evidence.
 */

const SIDES: readonly Side[] = ['a', 'b'];

function numberOf(metric: MetricValue | undefined): number | null {
  if (!metric) return null;
  if (metric.status === 'unavailable') return null;
  return typeof metric.value === 'number' ? metric.value : null;
}

/** "37 seconds", "2.5 minutes", "1.2 hours" */
export function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return Math.round(abs) + ' ms';
  if (abs < 90_000) return trimNumber(abs / 1000) + ' seconds';
  if (abs < 90 * 60_000) return trimNumber(abs / 60_000) + ' minutes';
  return trimNumber(abs / 3_600_000) + ' hours';
}

function trimNumber(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** "2.1x" */
export function humanRatio(ratio: number): string {
  return trimNumber(ratio) + 'x';
}

function percentDifference(lower: number, higher: number): number {
  if (higher <= 0) return 0;
  return Math.round(((higher - lower) / higher) * 100);
}

function other(side: Side): Side {
  return side === 'a' ? 'b' : 'a';
}

export function computeInsights(record: BattleRecord, events: readonly ArenaEvent[]): Insight[] {
  const out: Insight[] = [];
  const label: Record<Side, string> = { a: record.runs.a.label, b: record.runs.b.label };
  const metric = (side: Side, key: MetricKey) => numberOf(record.runs[side].metrics[key]);

  const add = (insight: Insight) => {
    out.push(insight);
  };

  // ---- first failing test observed by the agent itself -----------------------------------------
  // Only the agent's own test runs count: Arena's baseline/post runs (source.adapter 'arena') are
  // excluded, and time is measured from each side's run.started so sequential runs compare fairly.
  const runStart: Partial<Record<Side, number>> = {};
  for (const e of events) {
    if (e.type === 'run.started' && e.side && runStart[e.side] === undefined) runStart[e.side] = e.tOffsetMs;
  }
  const TEST_COMMAND = /\b(test|tests|vitest|jest|pytest|mocha|spec|cargo test|go test)\b/i;
  const commandById = new Map<string, string>();
  const firstFailingTest: Partial<Record<Side, ArenaEvent>> = {};
  for (const e of events) {
    const side = e.side;
    if (!side || firstFailingTest[side]) continue;
    if (e.source.adapter === 'arena') continue;
    if (e.type === 'command.started') {
      commandById.set(side + ':' + e.payload.commandId, e.payload.command);
      continue;
    }
    let failing = false;
    if (e.type === 'test.completed') failing = (e.payload.failed ?? 0) > 0;
    else if (e.type === 'command.completed') {
      const cmd = commandById.get(side + ':' + e.payload.commandId) ?? '';
      failing = TEST_COMMAND.test(cmd) && typeof e.payload.exitCode === 'number' && e.payload.exitCode !== 0;
    } else if (e.type === 'tool.result' && !e.payload.ok) {
      const cmd = commandById.get(side + ':' + e.payload.toolId) ?? '';
      failing = TEST_COMMAND.test(cmd);
    }
    if (failing) firstFailingTest[side] = e;
  }
  const fa = firstFailingTest.a;
  const fb = firstFailingTest.b;
  if (fa && fb && runStart.a !== undefined && runStart.b !== undefined) {
    const relA = fa.tOffsetMs - runStart.a;
    const relB = fb.tOffsetMs - runStart.b;
    if (relA !== relB) {
      const earlier: Side = relA < relB ? 'a' : 'b';
      const gap = Math.abs(relA - relB);
      add({
        id: 'first-failing-test',
        kind: 'timing',
        text: label[earlier] + ' found the failing test ' + humanDuration(gap) + ' earlier.',
        favors: earlier,
        support: { metrics: [], eventSeqs: [fa.seq, fb.seq] },
      });
    }
  }

  // ---- files inspected -------------------------------------------------------------------------
  const inspectedA = metric('a', 'files_inspected');
  const inspectedB = metric('b', 'files_inspected');
  if (inspectedA !== null && inspectedB !== null && inspectedA !== inspectedB) {
    const fewer: Side = inspectedA < inspectedB ? 'a' : 'b';
    add({
      id: 'files-inspected',
      kind: 'efficiency',
      text:
        label[fewer] +
        ' inspected fewer files (' +
        Math.min(inspectedA, inspectedB) +
        ' vs ' +
        Math.max(inspectedA, inspectedB) +
        ').',
      favors: fewer,
      support: { metrics: ['files_inspected'], eventSeqs: [] },
    });
  }

  // ---- retries ---------------------------------------------------------------------------------
  for (const side of SIDES) {
    const retries = metric(side, 'retries');
    if (retries !== null && retries > 0 && (metric(other(side), 'retries') ?? 0) < retries) {
      add({
        id: 'retries-' + side,
        kind: 'behavior',
        text:
          label[side] +
          ' required ' +
          retries +
          (retries === 1 ? ' retry' : ' retries') +
          ' before the suite passed.',
        favors: other(side),
        support: { metrics: ['retries'], eventSeqs: [] },
      });
    }
  }

  // ---- subagents -------------------------------------------------------------------------------
  for (const side of SIDES) {
    const spawned = metric(side, 'subagents_spawned');
    if (spawned !== null && spawned > 0 && (metric(other(side), 'subagents_spawned') ?? 0) === 0) {
      const seqs = events.filter((e) => e.side === side && e.type === 'subagent.spawned').map((e) => e.seq);
      add({
        id: 'subagents-' + side,
        kind: 'behavior',
        text:
          label[side] +
          ' spawned ' +
          (spawned === 1 ? 'a specialist subagent' : spawned + ' specialist subagents') +
          '; ' +
          label[other(side)] +
          ' worked in a single agent.',
        favors: 'none',
        support: { metrics: ['subagents_spawned'], eventSeqs: seqs.slice(0, 10) },
      });
    }
  }

  // ---- faster but more model interactions ------------------------------------------------------
  const durA = metric('a', 'duration_ms');
  const durB = metric('b', 'duration_ms');
  if (durA !== null && durB !== null && durA > 0 && durB > 0 && durA !== durB) {
    const faster: Side = durA < durB ? 'a' : 'b';
    const ratio = Math.max(durA, durB) / Math.min(durA, durB);
    for (const key of ['turns', 'model_requests'] as const) {
      const fast = metric(faster, key);
      const slow = metric(other(faster), key);
      if (fast === null || slow === null || fast <= slow) continue;
      add({
        id: 'faster-more-' + key,
        kind: 'timing',
        text:
          label[faster] +
          ' finished ' +
          humanRatio(ratio) +
          ' faster but used more ' +
          (key === 'turns' ? 'agent turns' : 'model requests') +
          ' (' +
          fast +
          ' vs ' +
          slow +
          ').',
        favors: 'none',
        support: { metrics: ['duration_ms', key], eventSeqs: [] },
      });
      break;
    }
  }

  // ---- tokens and cost, only when both sides observed them -------------------------------------
  for (const key of ['tokens_total', 'cost_usd'] as const) {
    const valueA = record.runs.a.metrics[key];
    const valueB = record.runs.b.metrics[key];
    if (valueA.status !== 'observed' || valueB.status !== 'observed') continue;
    const numA = numberOf(valueA);
    const numB = numberOf(valueB);
    if (numA === null || numB === null || numA === numB) continue;
    const cheaper: Side = numA < numB ? 'a' : 'b';
    const pct = percentDifference(Math.min(numA, numB), Math.max(numA, numB));
    if (pct <= 0) continue;
    add({
      id: 'cheaper-' + key,
      kind: 'efficiency',
      text:
        label[cheaper] +
        (key === 'tokens_total' ? ' used ' : ' cost ') +
        pct +
        '% ' +
        (key === 'tokens_total' ? 'fewer tokens' : 'less') +
        ' (' +
        formatMetric(key, Math.min(numA, numB)) +
        ' vs ' +
        formatMetric(key, Math.max(numA, numB)) +
        ').',
      favors: cheaper,
      support: { metrics: [key], eventSeqs: [] },
    });
  }

  // ---- regressions -----------------------------------------------------------------------------
  for (const side of SIDES) {
    const regressions = metric(side, 'regressions');
    if (regressions !== null && regressions > 0) {
      add({
        id: 'regressions-' + side,
        kind: 'warning',
        text:
          label[side] +
          ' broke ' +
          regressions +
          (regressions === 1 ? ' test that passed' : ' tests that passed') +
          ' before the change.',
        favors: other(side),
        support: { metrics: ['regressions'], eventSeqs: [] },
      });
    }
  }

  // ---- metrics that cannot be compared ---------------------------------------------------------
  const notComparable: MetricKey[] = ['cost_usd', 'tokens_total'];
  for (const key of notComparable) {
    const blind = SIDES.filter((s) => record.runs[s].metrics[key].status === 'unavailable');
    if (blind.length === 0) continue;
    const agents = [...new Set(blind.map((s) => record.runs[s].agent.id))].join(' and ');
    add({
      id: 'unavailable-' + key,
      kind: 'warning',
      text:
        (key === 'cost_usd' ? 'Cost' : 'Token usage') +
        ' is not reported by ' +
        agents +
        ', so it is shown as n/a rather than zero.',
      favors: 'none',
      support: { metrics: [key], eventSeqs: [] },
    });
  }

  return out;
}

function formatMetric(key: MetricKey, value: number): string {
  if (key === 'cost_usd') return '$' + value.toFixed(value < 1 ? 4 : 2);
  return value.toLocaleString('en-US');
}
