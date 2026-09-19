import {
  emptyMetrics,
  type ArenaEvent,
  type BattleRecord,
  type EventConfidence,
  type EventPayload,
  type EventType,
  type Insight,
  type ReportBundle,
  type RunMetrics,
  type RunRecord,
  type Side,
} from '@harness-arena/protocol';

/**
 * A hand-written sample battle. It exists so the landing page can show the real report components
 * with real shapes before anyone has run anything, and so the component tests have stable input.
 *
 * It is flagged demo: true everywhere. Nothing here is a measurement of a real harness.
 */

const BATTLE_ID = 'btl_demo0000000001';
const RUN_A_ID = 'run_demoaaaa00000001';
const RUN_B_ID = 'run_demobbbb00000001';
const START = Date.parse('2026-09-19T14:02:11.000Z');
const BATTLE_DURATION_MS = 301_400;
const RUN_A_DURATION_MS = 274_100;
const RUN_B_DURATION_MS = 239_600;

const iso = (offsetMs: number) => new Date(START + offsetMs).toISOString();

interface ScriptEntry {
  t: number;
  side: Side | null;
  type: EventType;
  payload: unknown;
  native?: string;
  confidence?: EventConfidence;
}

function at<T extends EventType>(
  t: number,
  side: Side | null,
  type: T,
  payload: EventPayload<T>,
  native?: string,
  confidence: EventConfidence = 'observed',
): ScriptEntry {
  return { t, side, type, payload, native, confidence };
}

const ADAPTER: Record<'a' | 'b' | 'arena', string> = {
  a: 'claude-code',
  b: 'codex',
  arena: 'arena',
};

function adapterFor(side: Side | null): string {
  return side ? ADAPTER[side] : ADAPTER.arena;
}

/** Repetitive-but-real stretches (file reads, tool loops) stay compact and deterministic. */
function reads(side: Side, startT: number, stepMs: number, paths: readonly string[]): ScriptEntry[] {
  return paths.map((path, index) =>
    at(
      startT + index * stepMs,
      side,
      'file.read',
      { path, bytes: 1200 + index * 317 },
      side === 'a' ? 'tool_use:Read' : 'item.completed:file_read',
      'observed',
    ),
  );
}

function toolPair(
  side: Side,
  t: number,
  toolId: string,
  name: string,
  summary: string,
  durationMs: number,
  ok = true,
  output?: string,
): ScriptEntry[] {
  return [
    at(t, side, 'tool.called', { toolId, name, summary }, side === 'a' ? 'tool_use' : 'item.started'),
    at(t + durationMs, side, 'tool.result', {
      toolId,
      name,
      ok,
      durationMs,
      ...(output ? { output } : {}),
    }),
  ];
}

const SCRIPT: ScriptEntry[] = [
  at(0, null, 'battle.started', {
    title: 'Fix the flaky retry backoff in the HTTP client',
    a: { label: 'claude-code + team-harness', agent: 'claude-code', harness: 'team-harness' },
    b: { label: 'codex + vanilla', agent: 'codex', harness: 'vanilla' },
    mode: 'local',
    demo: true,
  }),
  at(400, null, 'test.started', { command: 'pnpm vitest run', phase: 'baseline' }),
  at(18_900, null, 'test.completed', {
    command: 'pnpm vitest run',
    phase: 'baseline',
    exitCode: 1,
    passed: 39,
    failed: 3,
    skipped: 0,
    total: 42,
    durationMs: 18_500,
    parser: 'vitest',
  }),

  // ---- side A ---------------------------------------------------------------------------------
  at(19_400, 'a', 'run.started', {
    side: 'a',
    agent: 'claude-code',
    agentVersion: '2.1.278',
    model: 'claude-sonnet-4-6',
    harness: 'team-harness',
    harnessCommit: 'c41e77b9a2f0d5188ab3c9e4f6d70b21c8a5e913',
  }),
  at(19_900, 'a', 'agent.started', {
    sessionId: 'demo-session-a',
    model: 'claude-sonnet-4-6',
    version: '2.1.278',
    tools: ['Read', 'Edit', 'Bash', 'Grep', 'Task'],
    cwdKnown: true,
  }),
  at(20_100, 'a', 'model.request', { model: 'claude-sonnet-4-6', turn: 1 }),
  at(21_300, 'a', 'agent.thinking', { chars: 1840 }),
  at(23_800, 'a', 'model.response', {
    model: 'claude-sonnet-4-6',
    stopReason: 'tool_use',
    usage: {
      inputTokens: 14_210,
      outputTokens: 640,
      cacheReadTokens: 0,
      cacheWriteTokens: 12_800,
      totalTokens: 27_650,
    },
  }),
  at(24_200, 'a', 'agent.output', {
    role: 'assistant',
    text: 'Reading the retry module and its test first so I can reproduce the failure before changing anything.',
  }),
  ...reads('a', 24_800, 900, [
    'src/http/retry.ts',
    'src/http/client.ts',
    'test/retry.test.ts',
    'package.json',
    'CHANGELOG.md',
  ]),
  ...toolPair(
    'a',
    29_800,
    'toolu_a1',
    'Grep',
    'pattern "backoff" in src/',
    1100,
    true,
    '4 matches in 2 files',
  ),
  ...toolPair(
    'a',
    32_400,
    'toolu_a2',
    'Bash',
    'pnpm vitest run test/retry.test.ts',
    21_800,
    false,
    'FAIL test/retry.test.ts > retries with jitter > caps the delay at maxDelayMs',
  ),
  at(32_500, 'a', 'command.started', {
    commandId: 'cmd_a1',
    command: 'pnpm vitest run test/retry.test.ts',
    cwd: '.',
  }),
  at(54_100, 'a', 'command.completed', {
    commandId: 'cmd_a1',
    exitCode: 1,
    durationMs: 21_600,
    output: '3 failed | 8 passed (11)',
  }),
  at(55_200, 'a', 'model.request', { model: 'claude-sonnet-4-6', turn: 2 }),
  at(58_700, 'a', 'model.response', {
    model: 'claude-sonnet-4-6',
    stopReason: 'tool_use',
    usage: {
      inputTokens: 31_400,
      outputTokens: 1_180,
      cacheReadTokens: 24_900,
      cacheWriteTokens: 0,
      totalTokens: 57_480,
    },
  }),
  at(59_200, 'a', 'subagent.spawned', {
    subagentId: 'sub_a1',
    name: 'test-analyst',
    description: 'Explain why the jitter cap assertion fails without proposing a fix',
  }),
  ...reads('a', 60_100, 700, ['test/retry.test.ts', 'src/http/retry.ts', 'src/http/backoff.ts']),
  at(78_400, 'a', 'subagent.completed', { subagentId: 'sub_a1', status: 'completed', durationMs: 19_200 }),
  at(79_100, 'a', 'agent.output', {
    role: 'assistant',
    text: 'The cap is applied before jitter is added, so the delay can exceed maxDelayMs. Fixing the order and clamping after jitter.',
  }),
  ...toolPair('a', 80_200, 'toolu_a3', 'Edit', 'src/http/retry.ts: clamp after jitter', 1400),
  at(81_900, 'a', 'file.changed', {
    path: 'src/http/retry.ts',
    kind: 'modify',
    linesAdded: 14,
    linesRemoved: 6,
  }),
  ...toolPair('a', 83_100, 'toolu_a4', 'Edit', 'src/http/backoff.ts: export computeDelay', 1200),
  at(84_600, 'a', 'file.changed', {
    path: 'src/http/backoff.ts',
    kind: 'modify',
    linesAdded: 9,
    linesRemoved: 2,
  }),
  at(85_400, 'a', 'command.started', {
    commandId: 'cmd_a2',
    command: 'pnpm vitest run test/retry.test.ts',
    cwd: '.',
  }),
  at(104_800, 'a', 'command.completed', {
    commandId: 'cmd_a2',
    exitCode: 0,
    durationMs: 19_400,
    output: '11 passed (11)',
  }),
  at(105_900, 'a', 'model.request', { model: 'claude-sonnet-4-6', turn: 3 }),
  at(110_200, 'a', 'model.response', {
    model: 'claude-sonnet-4-6',
    stopReason: 'tool_use',
    usage: {
      inputTokens: 38_900,
      outputTokens: 1_460,
      cacheReadTokens: 34_100,
      cacheWriteTokens: 0,
      totalTokens: 74_460,
    },
  }),
  at(111_000, 'a', 'subagent.spawned', {
    subagentId: 'sub_a2',
    name: 'regression-sweeper',
    description: 'Run the full suite and report anything that changed state',
  }),
  at(111_800, 'a', 'command.started', { commandId: 'cmd_a3', command: 'pnpm vitest run', cwd: '.' }),
  at(141_300, 'a', 'command.completed', {
    commandId: 'cmd_a3',
    exitCode: 0,
    durationMs: 29_500,
    output: '42 passed (42)',
  }),
  at(142_100, 'a', 'subagent.completed', { subagentId: 'sub_a2', status: 'completed', durationMs: 31_100 }),
  ...toolPair('a', 143_200, 'toolu_a5', 'Read', 'docs/http-client.md', 600),
  ...toolPair('a', 145_000, 'toolu_a6', 'Edit', 'test/retry.test.ts: add jitter cap case', 1300),
  at(146_700, 'a', 'file.changed', {
    path: 'test/retry.test.ts',
    kind: 'modify',
    linesAdded: 21,
    linesRemoved: 0,
  }),
  at(147_900, 'a', 'command.started', { commandId: 'cmd_a4', command: 'pnpm exec tsc --noEmit', cwd: '.' }),
  at(168_400, 'a', 'command.completed', { commandId: 'cmd_a4', exitCode: 0, durationMs: 20_500, output: '' }),
  at(169_600, 'a', 'model.request', { model: 'claude-sonnet-4-6', turn: 4 }),
  at(174_100, 'a', 'model.response', {
    model: 'claude-sonnet-4-6',
    stopReason: 'tool_use',
    usage: {
      inputTokens: 42_600,
      outputTokens: 2_040,
      cacheReadTokens: 39_800,
      cacheWriteTokens: 0,
      totalTokens: 84_440,
    },
  }),
  ...toolPair('a', 175_000, 'toolu_a7', 'Bash', 'pnpm exec eslint src test', 12_600, true, ''),
  at(189_000, 'a', 'warning', {
    code: 'slow_command',
    message: 'eslint took 12.6s; the harness sets no lint cache directory.',
  }),
  at(190_200, 'a', 'command.started', { commandId: 'cmd_a5', command: 'pnpm vitest run', cwd: '.' }),
  at(221_700, 'a', 'command.completed', {
    commandId: 'cmd_a5',
    exitCode: 0,
    durationMs: 31_500,
    output: '43 passed (43)',
  }),
  at(223_000, 'a', 'model.request', { model: 'claude-sonnet-4-6', turn: 5 }),
  at(228_900, 'a', 'model.response', {
    model: 'claude-sonnet-4-6',
    stopReason: 'end_turn',
    usage: {
      inputTokens: 46_100,
      outputTokens: 3_120,
      cacheReadTokens: 43_400,
      cacheWriteTokens: 0,
      totalTokens: 92_620,
    },
  }),
  at(229_800, 'a', 'agent.output', {
    role: 'assistant',
    text:
      'Clamped the backoff after jitter is applied, exported computeDelay for direct testing, and added a ' +
      'regression test for the cap. Full suite: 43 passed, including the 3 that failed at baseline.',
    final: true,
  }),
  ...reads('a', 231_000, 800, ['src/http/retry.ts', 'test/retry.test.ts']),
  at(233_600, 'a', 'run.completed', {
    side: 'a',
    status: 'completed',
    exitCode: 0,
    durationMs: RUN_A_DURATION_MS,
  }),

  // ---- side B ---------------------------------------------------------------------------------
  at(19_600, 'b', 'run.started', {
    side: 'b',
    agent: 'codex',
    agentVersion: '0.154.0',
    model: 'gpt-5.4-codex',
    harness: 'vanilla',
    harnessCommit: null,
  }),
  at(20_200, 'b', 'agent.started', {
    sessionId: 'demo-thread-b',
    model: 'gpt-5.4-codex',
    version: '0.154.0',
  }),
  at(20_600, 'b', 'model.request', { model: 'gpt-5.4-codex', turn: 1 }),
  at(26_400, 'b', 'model.response', {
    model: 'gpt-5.4-codex',
    stopReason: 'tool_calls',
    usage: { inputTokens: 11_800, outputTokens: 910, totalTokens: 12_710 },
  }),
  at(27_000, 'b', 'agent.output', {
    role: 'assistant',
    text: 'Looking at the retry implementation and the failing assertion.',
  }),
  ...reads('b', 27_800, 1100, ['src/http/retry.ts', 'test/retry.test.ts', 'src/http/client.ts']),
  ...toolPair(
    'b',
    32_200,
    'call_b1',
    'shell',
    'pnpm vitest run test/retry.test.ts',
    20_400,
    false,
    '3 failed | 8 passed',
  ),
  at(32_300, 'b', 'command.started', {
    commandId: 'cmd_b1',
    command: 'pnpm vitest run test/retry.test.ts',
    cwd: '.',
  }),
  at(52_500, 'b', 'command.completed', {
    commandId: 'cmd_b1',
    exitCode: 1,
    durationMs: 20_200,
    output: '3 failed | 8 passed (11)',
  }),
  at(54_000, 'b', 'model.request', { model: 'gpt-5.4-codex', turn: 2 }),
  at(61_700, 'b', 'model.response', {
    model: 'gpt-5.4-codex',
    stopReason: 'tool_calls',
    usage: { inputTokens: 24_300, outputTokens: 1_520, totalTokens: 25_820 },
  }),
  ...toolPair('b', 62_400, 'call_b2', 'apply_patch', 'src/http/retry.ts: raise maxDelayMs default', 900),
  at(63_600, 'b', 'file.changed', {
    path: 'src/http/retry.ts',
    kind: 'modify',
    linesAdded: 7,
    linesRemoved: 3,
  }),
  at(64_400, 'b', 'command.started', {
    commandId: 'cmd_b2',
    command: 'pnpm vitest run test/retry.test.ts',
    cwd: '.',
  }),
  at(84_100, 'b', 'command.completed', {
    commandId: 'cmd_b2',
    exitCode: 1,
    durationMs: 19_700,
    output: '1 failed | 10 passed (11)',
  }),
  at(85_200, 'b', 'model.request', { model: 'gpt-5.4-codex', turn: 3 }),
  at(93_800, 'b', 'model.response', {
    model: 'gpt-5.4-codex',
    stopReason: 'tool_calls',
    usage: { inputTokens: 33_900, outputTokens: 2_140, totalTokens: 36_040 },
  }),
  ...reads('b', 94_600, 900, ['src/http/backoff.ts', 'src/http/retry.ts']),
  ...toolPair('b', 97_200, 'call_b3', 'apply_patch', 'src/http/backoff.ts: clamp jitter window', 1100),
  at(98_800, 'b', 'file.changed', {
    path: 'src/http/backoff.ts',
    kind: 'modify',
    linesAdded: 11,
    linesRemoved: 4,
  }),
  at(99_600, 'b', 'command.started', {
    commandId: 'cmd_b3',
    command: 'pnpm vitest run test/retry.test.ts',
    cwd: '.',
  }),
  at(118_900, 'b', 'command.completed', {
    commandId: 'cmd_b3',
    exitCode: 0,
    durationMs: 19_300,
    output: '11 passed (11)',
  }),
  at(120_100, 'b', 'agent.output', {
    role: 'assistant',
    text: 'Retry tests pass now. Checking the rest of the suite.',
  }),
  at(121_000, 'b', 'command.started', { commandId: 'cmd_b4', command: 'pnpm vitest run', cwd: '.' }),
  at(152_800, 'b', 'command.completed', {
    commandId: 'cmd_b4',
    exitCode: 1,
    durationMs: 31_800,
    output: '2 failed | 40 passed (42)',
  }),
  at(153_900, 'b', 'error', {
    code: 'test_failure',
    message: 'test/client.test.ts > retries on 503 > gives up after maxRetries attempts',
    fatal: false,
  }),
  at(154_800, 'b', 'model.request', { model: 'gpt-5.4-codex', turn: 4 }),
  at(163_400, 'b', 'model.response', {
    model: 'gpt-5.4-codex',
    stopReason: 'tool_calls',
    usage: { inputTokens: 41_700, outputTokens: 2_880, totalTokens: 44_580 },
  }),
  ...reads('b', 164_200, 1000, ['test/client.test.ts', 'src/http/client.ts']),
  ...toolPair('b', 167_000, 'call_b4', 'apply_patch', 'src/http/client.ts: pass maxRetries through', 1200),
  at(168_700, 'b', 'file.changed', {
    path: 'src/http/client.ts',
    kind: 'modify',
    linesAdded: 5,
    linesRemoved: 5,
  }),
  at(169_500, 'b', 'command.started', { commandId: 'cmd_b5', command: 'pnpm vitest run', cwd: '.' }),
  at(201_600, 'b', 'command.completed', {
    commandId: 'cmd_b5',
    exitCode: 1,
    durationMs: 32_100,
    output: '2 failed | 40 passed (42)',
  }),
  at(202_900, 'b', 'context.compacted', { trigger: 'token_budget' }),
  at(204_100, 'b', 'model.request', { model: 'gpt-5.4-codex', turn: 5 }),
  at(212_800, 'b', 'model.response', {
    model: 'gpt-5.4-codex',
    stopReason: 'tool_calls',
    usage: { inputTokens: 28_400, outputTokens: 1_960, totalTokens: 30_360 },
  }),
  ...toolPair('b', 213_600, 'call_b5', 'shell', 'pnpm exec tsc --noEmit', 19_800, true, ''),
  at(234_900, 'b', 'limit.hit', {
    kind: 'timeout',
    detail: 'per-run soft budget reached at 3m 40s of model time',
  }),
  at(236_200, 'b', 'agent.output', {
    role: 'assistant',
    text:
      'The jitter cap is fixed and typecheck is clean, but two client tests still fail: maxRetries is not ' +
      'threaded through the new delay path. Out of budget before finishing that.',
    final: true,
  }),
  at(237_400, 'b', 'run.completed', {
    side: 'b',
    status: 'completed',
    exitCode: 0,
    durationMs: RUN_B_DURATION_MS,
  }),

  // ---- evaluation -----------------------------------------------------------------------------
  at(240_000, null, 'evaluation.started', { evaluatorId: 'repo-tests', side: 'a' }),
  at(268_200, null, 'evaluation.completed', {
    evaluatorId: 'repo-tests',
    side: 'a',
    status: 'passed',
    summary: '43 passed, 0 failed, 0 regressions (baseline: 39 passed, 3 failed)',
  }),
  at(268_600, null, 'evaluation.started', { evaluatorId: 'repo-tests', side: 'b' }),
  at(297_100, null, 'evaluation.completed', {
    evaluatorId: 'repo-tests',
    side: 'b',
    status: 'failed',
    summary: '40 passed, 2 failed, 1 regression (baseline: 39 passed, 3 failed)',
  }),
  at(297_400, null, 'evaluation.started', { evaluatorId: 'diff-signals', side: null }),
  at(299_800, null, 'evaluation.completed', {
    evaluatorId: 'diff-signals',
    side: null,
    status: 'passed',
    summary: 'A: 3 files, +44/-6. B: 3 files, +23/-12. Neither side touched excluded paths.',
  }),
  at(300_400, null, 'warning', {
    code: 'judge_disabled',
    message: 'The optional LLM judge was not enabled, so no subjective opinion is included.',
  }),
  at(BATTLE_DURATION_MS, null, 'battle.completed', {
    status: 'completed',
    winner: 'a',
    durationMs: BATTLE_DURATION_MS,
  }),
];

function buildEvents(): ArenaEvent[] {
  const ordered = [...SCRIPT].sort((x, y) => x.t - y.t);
  return ordered.map((entry, index) => {
    const seq = index;
    const runId = entry.side === 'a' ? RUN_A_ID : entry.side === 'b' ? RUN_B_ID : null;
    const event = {
      v: 1 as const,
      id: `evt_demo${String(seq).padStart(5, '0')}`,
      battleId: BATTLE_ID,
      runId,
      side: entry.side,
      seq,
      ts: iso(entry.t),
      tOffsetMs: entry.t,
      source: { adapter: adapterFor(entry.side), ...(entry.native ? { native: entry.native } : {}) },
      confidence: entry.confidence ?? 'observed',
      type: entry.type,
      payload: entry.payload,
    };
    return event as ArenaEvent;
  });
}

export const SAMPLE_EVENTS: ArenaEvent[] = buildEvents();

const DIFF_A = `diff --git a/src/http/retry.ts b/src/http/retry.ts
index 3f8a1c2..b21d904 100644
--- a/src/http/retry.ts
+++ b/src/http/retry.ts
@@ -12,13 +12,21 @@ export interface RetryOptions {
   maxDelayMs: number;
 }

-export function nextDelay(attempt: number, options: RetryOptions): number {
-  const base = Math.min(options.baseDelayMs * 2 ** attempt, options.maxDelayMs);
-  return base + Math.random() * options.jitterMs;
-}
+export function nextDelay(attempt: number, options: RetryOptions, random = Math.random): number {
+  const exponential = options.baseDelayMs * 2 ** attempt;
+  const jitter = random() * options.jitterMs;
+  // Clamp AFTER jitter: clamping first let the jittered delay exceed maxDelayMs.
+  return Math.min(exponential + jitter, options.maxDelayMs);
+}
+
+export function delaySequence(attempts: number, options: RetryOptions, random = Math.random): number[] {
+  const out: number[] = [];
+  for (let attempt = 0; attempt < attempts; attempt++) out.push(nextDelay(attempt, options, random));
+  return out;
+}

 export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
   let lastError: unknown;
diff --git a/test/retry.test.ts b/test/retry.test.ts
index 9c1d3ba..4e77f10 100644
--- a/test/retry.test.ts
+++ b/test/retry.test.ts
@@ -28,6 +28,27 @@ describe('retries with jitter', () => {
     expect(nextDelay(3, options)).toBeGreaterThan(0);
   });

+  it('caps the delay at maxDelayMs even with maximum jitter', () => {
+    const options = { baseDelayMs: 250, jitterMs: 500, maxRetries: 5, maxDelayMs: 1000 };
+    const always1 = () => 0.999999;
+    for (let attempt = 0; attempt < 8; attempt++) {
+      expect(nextDelay(attempt, options, always1)).toBeLessThanOrEqual(options.maxDelayMs);
+    }
+  });
+
+  it('produces a monotonic sequence until the cap', () => {
+    const options = { baseDelayMs: 100, jitterMs: 0, maxRetries: 6, maxDelayMs: 800 };
+    const sequence = delaySequence(6, options, () => 0);
+    expect(sequence).toEqual([100, 200, 400, 800, 800, 800]);
+  });
+
   it('gives up after maxRetries attempts', async () => {
     const options = { baseDelayMs: 1, jitterMs: 0, maxRetries: 2, maxDelayMs: 10 };
     await expect(withRetry(failing, options)).rejects.toThrow();
`;

const DIFF_B = `diff --git a/src/http/backoff.ts b/src/http/backoff.ts
index 71b0ce4..8ad2f31 100644
--- a/src/http/backoff.ts
+++ b/src/http/backoff.ts
@@ -3,10 +3,17 @@
 export function jitterWindow(baseMs: number, jitterMs: number): [number, number] {
-  return [baseMs, baseMs + jitterMs];
+  const high = baseMs + jitterMs;
+  return [Math.max(0, baseMs), high];
 }

-export function clampDelay(delayMs: number, maxDelayMs: number): number {
-  return delayMs > maxDelayMs ? maxDelayMs : delayMs;
-}
+export function clampDelay(delayMs: number, maxDelayMs: number): number {
+  if (!Number.isFinite(delayMs)) return maxDelayMs;
+  return Math.min(Math.max(0, delayMs), maxDelayMs);
+}
diff --git a/src/http/client.ts b/src/http/client.ts
index 2d4b81a..6f0e5c9 100644
--- a/src/http/client.ts
+++ b/src/http/client.ts
@@ -44,11 +44,11 @@ export class HttpClient {
   private async send(request: Request, attempt = 0): Promise<Response> {
     const response = await this.fetch(request);
     if (!RETRYABLE.has(response.status)) return response;
-    if (attempt >= this.options.maxRetries) return response;
-    await sleep(nextDelay(attempt, this.options));
+    if (attempt >= (this.options.maxRetries ?? 3)) return response;
+    await sleep(clampDelay(nextDelay(attempt, this.options), this.options.maxDelayMs));
     return this.send(request, attempt + 1);
   }
`;

function metricsA(): RunMetrics {
  const m = emptyMetrics();
  m.completion_status = { value: 'completed', status: 'calculated', source: 'core:run' };
  m.exit_code = { value: 0, status: 'observed', source: 'core:process' };
  m.tests_passed = { value: 43, status: 'observed', source: 'evaluator:repo-tests' };
  m.tests_failed = { value: 0, status: 'observed', source: 'evaluator:repo-tests' };
  m.tests_total = { value: 43, status: 'observed', source: 'evaluator:repo-tests' };
  m.regressions = {
    value: 0,
    status: 'calculated',
    source: 'evaluator:repo-tests',
    note: 'vs baseline 39/3',
  };
  m.duration_ms = { value: RUN_A_DURATION_MS, status: 'calculated', source: 'core:timer' };
  m.tokens_input = { value: 46_100, status: 'observed', source: 'claude-code:result.usage' };
  m.tokens_output = { value: 3_120, status: 'observed', source: 'claude-code:result.usage' };
  m.tokens_cache_read = { value: 117_300, status: 'observed', source: 'claude-code:result.usage' };
  m.tokens_cache_write = { value: 12_800, status: 'observed', source: 'claude-code:result.usage' };
  m.tokens_total = { value: 179_320, status: 'observed', source: 'claude-code:result.usage' };
  m.cost_usd = {
    value: 2.81,
    status: 'observed',
    source: 'claude-code:result.total_cost_usd',
    note: 'List-price estimate reported by the CLI, not a subscription charge.',
  };
  m.model_requests = { value: 5, status: 'observed', source: 'claude-code:stream' };
  m.turns = { value: 5, status: 'observed', source: 'claude-code:result.num_turns' };
  m.tool_calls = { value: 14, status: 'observed', source: 'claude-code:stream' };
  m.commands_run = { value: 5, status: 'observed', source: 'claude-code:stream' };
  m.files_inspected = { value: 10, status: 'observed', source: 'claude-code:stream' };
  m.files_changed = { value: 3, status: 'calculated', source: 'core:git-diff' };
  m.lines_added = { value: 44, status: 'calculated', source: 'core:git-diff' };
  m.lines_removed = { value: 6, status: 'calculated', source: 'core:git-diff' };
  m.subagents_spawned = { value: 2, status: 'observed', source: 'claude-code:subagent_stats' };
  m.errors = { value: 0, status: 'calculated', source: 'core:events' };
  m.human_interventions = { value: 0, status: 'calculated', source: 'core:events' };
  m.context_compactions = { value: 0, status: 'observed', source: 'claude-code:stream' };
  m.retries = {
    value: null,
    status: 'unavailable',
    note: 'The CLI does not report internal request retries.',
  };
  return m;
}

function metricsB(): RunMetrics {
  const m = emptyMetrics();
  m.completion_status = { value: 'completed', status: 'calculated', source: 'core:run' };
  m.exit_code = { value: 0, status: 'observed', source: 'core:process' };
  m.tests_passed = { value: 40, status: 'observed', source: 'evaluator:repo-tests' };
  m.tests_failed = { value: 2, status: 'observed', source: 'evaluator:repo-tests' };
  m.tests_total = { value: 42, status: 'observed', source: 'evaluator:repo-tests' };
  m.regressions = {
    value: 1,
    status: 'calculated',
    source: 'evaluator:repo-tests',
    note: 'vs baseline 39/3',
  };
  m.duration_ms = { value: RUN_B_DURATION_MS, status: 'calculated', source: 'core:timer' };
  m.tokens_input = { value: 140_100, status: 'observed', source: 'codex:turn.completed.usage' };
  m.tokens_output = { value: 9_410, status: 'observed', source: 'codex:turn.completed.usage' };
  m.tokens_total = { value: 149_510, status: 'observed', source: 'codex:turn.completed.usage' };
  m.cost_usd = {
    value: null,
    status: 'unavailable',
    note: 'Codex exec does not report cost. Arena will not guess a dollar figure.',
  };
  m.model_requests = { value: 5, status: 'observed', source: 'codex:turn.started' };
  m.turns = { value: 5, status: 'observed', source: 'codex:turn.completed' };
  m.tool_calls = { value: 5, status: 'observed', source: 'codex:item.completed' };
  m.commands_run = { value: 5, status: 'observed', source: 'codex:item.completed' };
  m.files_inspected = { value: 7, status: 'observed', source: 'codex:item.completed' };
  m.files_changed = { value: 3, status: 'calculated', source: 'core:git-diff' };
  m.lines_added = { value: 23, status: 'calculated', source: 'core:git-diff' };
  m.lines_removed = { value: 12, status: 'calculated', source: 'core:git-diff' };
  m.subagents_spawned = {
    value: null,
    status: 'unavailable',
    note: 'Codex exec has no subagent concept to observe.',
  };
  m.errors = { value: 1, status: 'calculated', source: 'core:events' };
  m.human_interventions = { value: 0, status: 'calculated', source: 'core:events' };
  m.context_compactions = { value: 1, status: 'observed', source: 'codex:item.completed' };
  m.retries = { value: null, status: 'unavailable', note: 'Not reported by this CLI.' };
  return m;
}

const RUN_A: RunRecord = {
  id: RUN_A_ID,
  side: 'a',
  label: 'claude-code + team-harness',
  status: 'completed',
  agent: {
    id: 'claude-code',
    version: '2.1.278',
    model: 'claude-sonnet-4-6',
    capabilities: {
      tokens: 'observed',
      cost: 'observed',
      model: 'observed',
      toolCalls: 'observed',
      commands: 'observed',
      fileReads: 'observed',
      fileChanges: 'observed',
      subagents: 'observed',
      turns: 'observed',
      thinking: 'observed',
      contextCompaction: 'observed',
    },
  },
  harness: {
    name: 'team-harness',
    source: 'https://github.com/arena-demo/team-harness',
    kind: 'github',
    commit: 'c41e77b9a2f0d5188ab3c9e4f6d70b21c8a5e913',
    manifest: {
      arena: 1,
      name: 'team-harness',
      version: '0.4.2',
      description: 'Team conventions, review skills and a test-analyst subagent.',
      agents: ['claude-code'],
      files: ['CLAUDE.md', '.claude'],
      capabilities: { subagents: true, skills: true, hooks: true, commands: true, mcp: false },
    },
    appliedFiles: [
      'CLAUDE.md',
      '.claude/settings.json',
      '.claude/agents/test-analyst.md',
      '.claude/agents/regression-sweeper.md',
      '.claude/skills/repo-conventions/SKILL.md',
    ],
    executedCommands: [],
    skippedFiles: [],
  },
  startedAt: iso(19_400),
  completedAt: iso(19_400 + RUN_A_DURATION_MS),
  durationMs: RUN_A_DURATION_MS,
  exitCode: 0,
  metrics: metricsA(),
  artifacts: {
    diff: DIFF_A,
    diffBytes: DIFF_A.length,
    finalResponse:
      'Clamped the backoff after jitter is applied, exported computeDelay for direct testing, and added a ' +
      'regression test for the cap. Full suite: 43 passed, including the 3 that failed at baseline.',
    changedFiles: [
      { path: 'src/http/retry.ts', kind: 'modify', linesAdded: 14, linesRemoved: 6 },
      { path: 'src/http/backoff.ts', kind: 'modify', linesAdded: 9, linesRemoved: 0 },
      { path: 'test/retry.test.ts', kind: 'modify', linesAdded: 21, linesRemoved: 0 },
    ],
  },
  error: null,
  eventCount: SAMPLE_EVENTS.filter((e) => e.side === 'a').length,
  invocation: {
    command: 'claude',
    args: [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project,local',
      '--strict-mcp-config',
      '--model',
      'claude-sonnet-4-6',
    ],
    envKeys: ['ARENA_BATTLE_ID', 'ARENA_RUN_ID'],
  },
};

const RUN_B: RunRecord = {
  id: RUN_B_ID,
  side: 'b',
  label: 'codex + vanilla',
  status: 'completed',
  agent: {
    id: 'codex',
    version: '0.154.0',
    model: 'gpt-5.4-codex',
    capabilities: {
      tokens: 'observed',
      cost: 'unavailable',
      model: 'observed',
      toolCalls: 'observed',
      commands: 'observed',
      fileReads: 'observed',
      fileChanges: 'derived',
      subagents: 'unavailable',
      turns: 'observed',
      thinking: 'unavailable',
      contextCompaction: 'observed',
    },
  },
  harness: {
    name: 'vanilla',
    source: 'vanilla',
    kind: 'vanilla',
    commit: null,
    manifest: null,
    appliedFiles: [],
    executedCommands: [],
    skippedFiles: [],
  },
  startedAt: iso(19_600),
  completedAt: iso(19_600 + RUN_B_DURATION_MS),
  durationMs: RUN_B_DURATION_MS,
  exitCode: 0,
  metrics: metricsB(),
  artifacts: {
    diff: DIFF_B,
    diffBytes: DIFF_B.length,
    finalResponse:
      'The jitter cap is fixed and typecheck is clean, but two client tests still fail: maxRetries is not ' +
      'threaded through the new delay path. Out of budget before finishing that.',
    changedFiles: [
      { path: 'src/http/backoff.ts', kind: 'modify', linesAdded: 11, linesRemoved: 4 },
      { path: 'src/http/client.ts', kind: 'modify', linesAdded: 5, linesRemoved: 5 },
      { path: 'src/http/retry.ts', kind: 'modify', linesAdded: 7, linesRemoved: 3 },
    ],
  },
  error: null,
  eventCount: SAMPLE_EVENTS.filter((e) => e.side === 'b').length,
  invocation: {
    command: 'codex',
    args: ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--model', 'gpt-5.4-codex'],
    envKeys: ['ARENA_BATTLE_ID', 'ARENA_RUN_ID'],
  },
};

const INSIGHTS: Insight[] = [
  {
    id: 'ins_baseline_first',
    kind: 'behavior',
    text:
      'A ran the failing test before editing anything and B edited first. A reproduced the failure in 13 seconds; ' +
      'B spent two edit-test cycles on the wrong cause.',
    favors: 'a',
    support: { metrics: ['tool_calls'], eventSeqs: [21, 47] },
  },
  {
    id: 'ins_cache_efficiency',
    kind: 'efficiency',
    text:
      'A sent 46.1k fresh input tokens against 117.3k cache reads. B has no cache reporting, so its 140.1k ' +
      'input tokens are not directly comparable.',
    favors: 'none',
    support: { metrics: ['tokens_input', 'tokens_cache_read'], eventSeqs: [] },
  },
  {
    id: 'ins_regression',
    kind: 'quality',
    text: 'B introduced one regression in test/client.test.ts that was passing at baseline. A introduced none.',
    favors: 'a',
    support: { metrics: ['regressions', 'tests_failed'], eventSeqs: [96] },
  },
  {
    id: 'ins_budget',
    kind: 'warning',
    text: 'B hit its per-run soft budget with two tests still failing, so its run ended early rather than wrong.',
    favors: 'none',
    support: { metrics: ['duration_ms'], eventSeqs: [110] },
  },
];

export const SAMPLE_RECORD: BattleRecord = {
  id: BATTLE_ID,
  protocolVersion: 1,
  arenaVersion: '0.1.0',
  status: 'completed',
  spec: {
    version: 1,
    title: 'Fix the flaky retry backoff in the HTTP client',
    task: {
      kind: 'prompt',
      title: 'Fix the flaky retry backoff in the HTTP client',
      prompt:
        'test/retry.test.ts has three failing cases around jittered backoff. Find the cause, fix it, and make ' +
        'sure the whole suite passes. Do not change the public API.',
    },
    repository: {
      source: 'https://github.com/arena-demo/http-client',
      ref: 'main',
      commit: '9f2c1ab4d7e6350c81b2a9f4e7d0c63b5a184f2e',
      submodules: false,
    },
    competitors: {
      a: {
        label: 'claude-code + team-harness',
        agent: { id: 'claude-code', model: 'claude-sonnet-4-6' },
        harness: { source: 'https://github.com/arena-demo/team-harness', ref: 'main', trusted: true },
      },
      b: {
        label: 'codex + vanilla',
        agent: { id: 'codex', model: 'gpt-5.4-codex' },
        harness: { source: 'vanilla', trusted: true },
      },
    },
    limits: {
      timeoutMs: 1_200_000,
      maxTurns: 40,
      maxOutputBytes: 52_428_800,
    },
    evaluation: {
      tests: { command: 'pnpm vitest run', baseline: true, parser: 'vitest', timeoutMs: 600_000 },
      typecheck: ['pnpm exec tsc --noEmit'],
      assertions: [
        {
          type: 'file-contains',
          path: 'src/http/retry.ts',
          pattern: 'maxDelayMs',
          label: 'keeps the cap option',
        },
        { type: 'diff-not-touches', paths: ['package.json'], label: 'no dependency changes' },
      ],
      judge: { enabled: false },
    },
    privacy: { upload: 'none', exclude: [], redact: true },
    mode: 'local',
    visibility: 'public',
    parallel: true,
    tags: ['demo', 'debugging'],
    category: 'debugging',
  },
  task: {
    title: 'Fix the flaky retry backoff in the HTTP client',
    prompt:
      'test/retry.test.ts has three failing cases around jittered backoff. Find the cause, fix it, and make ' +
      'sure the whole suite passes. Do not change the public API.',
    source: { kind: 'demo' },
  },
  repository: {
    source: 'https://github.com/arena-demo/http-client',
    kind: 'github',
    commit: '9f2c1ab4d7e6350c81b2a9f4e7d0c63b5a184f2e',
    ref: 'main',
    dirty: false,
  },
  environment: {
    os: { platform: 'win32', release: '10.0.26200', arch: 'x64' },
    node: 'v24.10.0',
    git: '2.51.0',
    arenaVersion: '0.1.0',
    ci: false,
    cpuCount: 16,
    memoryGb: 32,
    agents: {
      'claude-code': { version: '2.1.278', userConfigIsolated: true },
      codex: { version: '0.154.0', userConfigIsolated: true },
    },
    sharedFlags: {
      'claude-code': ['--setting-sources project,local', '--strict-mcp-config'],
      codex: ['--ignore-user-config', '--ignore-rules'],
    },
    recordedAt: iso(0),
  },
  runs: { a: RUN_A, b: RUN_B },
  evaluation: {
    results: [
      {
        evaluatorId: 'repo-tests',
        kind: 'deterministic',
        side: 'a',
        status: 'passed',
        score: 1,
        summary: '43 passed, 0 failed, 0 regressions',
        durationMs: 28_200,
      },
      {
        evaluatorId: 'repo-tests',
        kind: 'deterministic',
        side: 'b',
        status: 'failed',
        score: 0.95,
        summary: '40 passed, 2 failed, 1 regression',
        durationMs: 28_500,
      },
      {
        evaluatorId: 'typecheck',
        kind: 'deterministic',
        side: 'a',
        status: 'passed',
        score: 1,
        summary: 'tsc --noEmit clean',
        durationMs: 20_500,
      },
      {
        evaluatorId: 'typecheck',
        kind: 'deterministic',
        side: 'b',
        status: 'passed',
        score: 1,
        summary: 'tsc --noEmit clean',
        durationMs: 19_800,
      },
      {
        evaluatorId: 'assertions',
        kind: 'deterministic',
        side: 'a',
        status: 'passed',
        score: 1,
        summary: '2 of 2 assertions held',
        durationMs: 420,
      },
      {
        evaluatorId: 'assertions',
        kind: 'deterministic',
        side: 'b',
        status: 'passed',
        score: 1,
        summary: '2 of 2 assertions held',
        durationMs: 380,
      },
      {
        evaluatorId: 'diff-signals',
        kind: 'deterministic',
        side: null,
        status: 'passed',
        score: null,
        summary: 'A: 3 files, +44/-6. B: 3 files, +23/-12. No excluded path was touched.',
        durationMs: 2_400,
      },
    ],
    comparisons: [
      {
        key: 'tests_failed',
        label: 'Tests failed',
        a: { value: 0, status: 'observed', source: 'evaluator:repo-tests' },
        b: { value: 2, status: 'observed', source: 'evaluator:repo-tests' },
        better: 'a',
        significance: 'decisive',
      },
      {
        key: 'regressions',
        label: 'Regressions',
        a: { value: 0, status: 'calculated', source: 'evaluator:repo-tests' },
        b: { value: 1, status: 'calculated', source: 'evaluator:repo-tests' },
        better: 'a',
        significance: 'decisive',
      },
      {
        key: 'duration_ms',
        label: 'Duration',
        a: { value: RUN_A_DURATION_MS, status: 'calculated', source: 'core:timer' },
        b: { value: RUN_B_DURATION_MS, status: 'calculated', source: 'core:timer' },
        better: 'b',
        significance: 'notable',
      },
      {
        key: 'tokens_total',
        label: 'Tokens',
        a: { value: 179_320, status: 'observed', source: 'claude-code:result.usage' },
        b: { value: 149_510, status: 'observed', source: 'codex:turn.completed.usage' },
        better: 'b',
        significance: 'notable',
      },
      {
        key: 'cost_usd',
        label: 'Cost',
        a: { value: 2.81, status: 'observed', source: 'claude-code:result.total_cost_usd' },
        b: { value: null, status: 'unavailable', note: 'Codex exec does not report cost.' },
        better: 'n/a',
        significance: 'none',
      },
    ],
    evidence: [
      { label: 'Tests failing after the run', a: 0, b: 2, favors: 'a' },
      { label: 'Regressions vs baseline', a: 0, b: 1, favors: 'a' },
      { label: 'Wall-clock duration', a: '4:34', b: '3:60', favors: 'b' },
      { label: 'Reproduced the failure before editing', a: true, b: false, favors: 'a' },
      { label: 'Cost reported by the CLI', a: '$2.81', b: null, favors: 'none' },
    ],
    unavailable: [
      { evaluatorId: 'llm-judge', reason: 'Not enabled for this battle (judge.enabled = false).' },
      { evaluatorId: 'hidden-tests', reason: 'No hidden benchmark suite is configured for this repository.' },
    ],
    completedAt: iso(300_000),
  },
  verdict: {
    winner: 'a',
    confidence: 0.82,
    method: 'deterministic',
    reasons: [
      'A left the suite green (43 passed, 0 failed); B left 2 failing.',
      'B introduced 1 regression in a test that passed at baseline; A introduced none.',
      'Both sides satisfied every configured assertion and both typechecked clean.',
    ],
    decisiveFactors: ['tests_failed', 'regressions'],
    caveats: [
      'One task, one run per side. This is a single sample, not a benchmark.',
      'Both runs executed in parallel on the same machine, so wall-clock duration is only roughly comparable.',
      'Cost cannot be compared: the Codex CLI does not report it.',
      'Different agents and different models, so the harness is not the only variable.',
    ],
    judge: null,
  },
  insights: INSIGHTS,
  verification: { kind: 'local', eligible: false, sandbox: null },
  demo: true,
  createdAt: iso(0),
  startedAt: iso(0),
  completedAt: iso(BATTLE_DURATION_MS),
  error: null,
};

export const SAMPLE_BUNDLE: ReportBundle = {
  record: SAMPLE_RECORD,
  events: SAMPLE_EVENTS,
  generatedAt: iso(BATTLE_DURATION_MS + 1200),
  arenaVersion: '0.1.0',
};

/** The shape the report components consume. */
export interface SampleReport {
  record: BattleRecord;
  events: ArenaEvent[];
}

export const SAMPLE_REPORT: SampleReport = { record: SAMPLE_RECORD, events: SAMPLE_EVENTS };
