/**
 * Regenerates the builtin fake-adapter fixtures.
 *
 *   node packages/adapters/fixtures/fake/generate.mjs
 *
 * The demo fixtures carry 63 and 147 tool calls, so they are generated rather than hand-written.
 * Everything here is deterministic: no clock, no randomness. The timelines, token shares and file
 * operations are internally consistent, and the two demo runs really fix a failing node:test suite
 * inside the workspace, so `git diff` and the evaluators see a plausible patch.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = dirname(fileURLToPath(import.meta.url));

// ---- the tiny Node project both demo runs work on --------------------------------------------

const PACKAGE_JSON = `{
  "name": "session-demo",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

const README = `# session-demo

A minimal auth-session helper used by the Harness Arena demo battle.

- \`src/auth/session.js\` creates sessions and answers whether one has expired.
- \`npm test\` runs the node:test suite.
`;

const README_WITH_NOTE = `${README}
## Notes

Session expiry is stored in seconds (UNIX time) and compared in milliseconds.
`;

const SESSION_BUGGY = `const SESSION_TTL_SECONDS = 3600;

/**
 * A session stores \`expiresAt\` as a UNIX timestamp in SECONDS.
 */
export function createSession(userId, now = Date.now()) {
  return { userId, expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
}

export function isExpired(session, now = Date.now()) {
  return session.expiresAt <= now;
}
`;

const SESSION_FIXED = `const SESSION_TTL_SECONDS = 3600;
const SECOND_MS = 1000;

/**
 * A session stores \`expiresAt\` as a UNIX timestamp in SECONDS.
 */
export function createSession(userId, now = Date.now()) {
  return { userId, expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
}

export function isExpired(session, now = Date.now()) {
  return session.expiresAt * SECOND_MS <= now;
}
`;

const TEST_BASE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, isExpired } from '../src/auth/session.js';

const NOW = 1700000000000;

test('a session that expired a minute ago is expired', () => {
  assert.equal(isExpired({ expiresAt: NOW / 1000 - 60 }, NOW), true);
});

test('a fresh session is not expired', () => {
  assert.equal(isExpired(createSession('u1', NOW), NOW), false);
});
`;

const TEST_REGRESSION = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpired } from '../src/auth/session.js';

const NOW = 1700000000000;

test('a session expiring exactly now is expired', () => {
  assert.equal(isExpired({ expiresAt: NOW / 1000 }, NOW), true);
});

test('seconds are never compared against milliseconds', () => {
  assert.equal(isExpired({ expiresAt: NOW / 1000 + 1 }, NOW), false);
});
`;

const TEST_EXTENDED = `${TEST_BASE}
test('a session one second from expiry is still valid', () => {
  assert.equal(isExpired({ expiresAt: NOW / 1000 + 1 }, NOW), false);
});
`;

const TEST_FAIL_OUTPUT = `# Subtest: a fresh session is not expired
not ok 2 - a fresh session is not expired
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: true !== false
# pass 1
# fail 1
`;

const TEST_PASS_OUTPUT = `# pass 2
# fail 0
# cancelled 0
`;

const TEST_PASS_OUTPUT_3 = `# pass 3
# fail 0
# cancelled 0
`;

const TEST_PASS_OUTPUT_4 = `# pass 4
# fail 0
# cancelled 0
`;

// ---- small helpers ----------------------------------------------------------------------------

const READ_TARGETS = [
  'package.json',
  'src/auth/session.js',
  'test/session.test.js',
  'README.md',
  'src/auth/token.js',
  'src/auth/index.js',
  'src/server.js',
  'src/config.js',
  'src/auth/middleware.js',
  'test/token.test.js',
  'src/db/users.js',
  'src/util/time.js',
  'src/util/log.js',
  'src/routes/login.js',
  'src/routes/logout.js',
  'src/auth/policy.js',
  'docs/auth.md',
  'src/index.js',
];

const GREP_PATTERNS = ['expiresAt', 'isExpired', 'Date.now', 'SESSION_TTL', 'session', 'expiry'];
const GLOB_PATTERNS = ['src/**/*.js', 'test/**/*.test.js', '**/*.json', 'docs/**/*.md'];

function step(atMs, event) {
  return { atMs, event };
}

function fsStep(atMs, op, path, content) {
  const fs = content === undefined ? { op, path } : { op, path, content };
  return { atMs, fs };
}

/** Split an integer total into n parts that sum exactly to the total. */
function shares(total, n) {
  const base = Math.floor(total / n);
  const out = new Array(n).fill(base);
  out[n - 1] += total - base * n;
  return out;
}

/** Split a dollar amount into n parts that sum exactly to the total, to the micro-dollar. */
function costShares(total, n) {
  return shares(Math.round(total * 1e6), n).map((micro) => micro / 1e6);
}

function bootstrap(withReadme) {
  const steps = [
    fsStep(0, 'write', 'package.json', PACKAGE_JSON),
    fsStep(0, 'write', 'src/auth/session.js', SESSION_BUGGY),
    fsStep(0, 'write', 'test/session.test.js', TEST_BASE),
  ];
  if (withReadme) steps.push(fsStep(0, 'write', 'README.md', README));
  return steps;
}

/**
 * Build the tool-call timeline for one demo run.
 * `plan` entries describe what each tool call does; the generator turns them into events, file
 * operations and evenly spaced timestamps.
 */
function buildRun(options) {
  const { plan, spanMs, model, sessionId, turns, usage, agentVersion, finalText, tools } = options;
  const steps = bootstrap(true);
  const count = plan.length;

  steps.push(
    step(0, {
      type: 'agent.started',
      native: 'system/init',
      confidence: 'observed',
      payload: { sessionId, model, version: agentVersion, tools, cwdKnown: true },
    }),
  );

  const atOf = (index) => Math.round(((index + 1) * spanMs) / count);
  let fillerIndex = 0;

  plan.forEach((entry, index) => {
    const at = atOf(index);
    const toolId = `toolu_${String(index + 1).padStart(3, '0')}`;

    if (entry.kind === 'read') {
      steps.push(
        step(at, {
          type: 'tool.called',
          native: 'assistant/tool_use',
          confidence: 'observed',
          payload: { toolId, name: 'Read', input: { file_path: entry.path }, parentToolId: null },
        }),
        step(at, {
          type: 'file.read',
          native: 'assistant/tool_use:Read',
          confidence: 'observed',
          payload: { path: entry.path },
        }),
        step(at + 40, {
          type: 'tool.result',
          native: 'user/tool_result',
          confidence: 'observed',
          payload: { toolId, name: 'Read', ok: true, output: `read ${entry.path}` },
        }),
      );
      return;
    }

    if (entry.kind === 'filler') {
      const useGlob = fillerIndex % 4 === 3;
      const name = useGlob ? 'Glob' : 'Grep';
      const input = useGlob
        ? { pattern: GLOB_PATTERNS[fillerIndex % GLOB_PATTERNS.length] }
        : { pattern: GREP_PATTERNS[fillerIndex % GREP_PATTERNS.length] };
      fillerIndex += 1;
      steps.push(
        step(at, {
          type: 'tool.called',
          native: 'assistant/tool_use',
          confidence: 'observed',
          payload: { toolId, name, input, parentToolId: null },
        }),
        step(at + 30, {
          type: 'tool.result',
          native: 'user/tool_result',
          confidence: 'observed',
          payload: { toolId, name, ok: true, output: `${name} completed` },
        }),
      );
      return;
    }

    if (entry.kind === 'bash') {
      steps.push(
        step(at, {
          type: 'tool.called',
          native: 'assistant/tool_use',
          confidence: 'observed',
          payload: { toolId, name: 'Bash', input: { command: entry.command }, parentToolId: null },
        }),
        step(at, {
          type: 'command.started',
          native: 'assistant/tool_use:Bash',
          confidence: 'observed',
          payload: { commandId: toolId, command: entry.command },
        }),
        step(at + entry.durationMs, {
          type: 'command.completed',
          native: 'user/tool_result',
          confidence: 'observed',
          payload: {
            commandId: toolId,
            exitCode: entry.exitCode,
            durationMs: entry.durationMs,
            output: entry.output,
          },
        }),
        step(at + entry.durationMs, {
          type: 'tool.result',
          native: 'user/tool_result',
          confidence: 'observed',
          payload: { toolId, name: 'Bash', ok: entry.exitCode === 0, output: entry.output },
        }),
      );
      if (entry.warning) {
        steps.push(
          step(at + entry.durationMs + 10, {
            type: 'warning',
            native: 'arena/retry',
            confidence: 'observed',
            payload: { code: 'retry', message: entry.warning },
          }),
        );
      }
      return;
    }

    if (entry.kind === 'task') {
      steps.push(
        step(at, {
          type: 'tool.called',
          native: 'assistant/tool_use',
          confidence: 'observed',
          payload: {
            toolId,
            name: 'Task',
            input: { subagent_type: entry.subagent, description: entry.description },
            parentToolId: null,
          },
        }),
        step(at, {
          type: 'subagent.spawned',
          native: 'assistant/tool_use:Task',
          confidence: 'observed',
          payload: { subagentId: toolId, name: entry.subagent, description: entry.description },
        }),
        step(at + entry.durationMs, {
          type: 'tool.result',
          native: 'user/tool_result',
          confidence: 'observed',
          payload: { toolId, name: 'Task', ok: true, output: entry.output },
        }),
        step(at + entry.durationMs, {
          type: 'subagent.completed',
          native: 'user/tool_result',
          confidence: 'observed',
          payload: { subagentId: toolId, status: 'completed', durationMs: entry.durationMs },
        }),
      );
      return;
    }

    // edit or write: the file operation really lands in the workspace
    const toolName = entry.kind === 'write' ? 'Write' : 'Edit';
    steps.push(
      step(at, {
        type: 'tool.called',
        native: 'assistant/tool_use',
        confidence: 'observed',
        payload: { toolId, name: toolName, input: { file_path: entry.path }, parentToolId: null },
      }),
      fsStep(at, 'write', entry.path, entry.content),
      step(at, {
        type: 'file.changed',
        native: `assistant/tool_use:${toolName}`,
        confidence: 'observed',
        payload: {
          path: entry.path,
          kind: entry.kind === 'write' ? 'create' : 'modify',
          linesAdded: entry.linesAdded,
          linesRemoved: entry.linesRemoved,
        },
      }),
      step(at + 25, {
        type: 'tool.result',
        native: 'user/tool_result',
        confidence: 'observed',
        payload: { toolId, name: toolName, ok: true, output: `applied to ${entry.path}` },
      }),
    );
  });

  // thinking blocks, spread across the run
  const thinkingChars = [820, 1340, 610, 2110, 940];
  thinkingChars.forEach((chars, i) => {
    const at = Math.round((spanMs * (i + 1)) / (thinkingChars.length + 2));
    steps.push(
      step(at, {
        type: 'agent.thinking',
        native: 'assistant/thinking',
        confidence: 'observed',
        payload: { chars },
      }),
    );
  });

  // one model.response per turn, with token and cost shares that sum to the run totals
  const inputShares = shares(usage.inputTokens, turns);
  const outputShares = shares(usage.outputTokens, turns);
  const cacheShares = usage.cacheReadTokens === undefined ? null : shares(usage.cacheReadTokens, turns);
  const costs = costShares(usage.costUsd, turns);
  for (let turn = 0; turn < turns; turn += 1) {
    const at = Math.round((spanMs * (turn + 1)) / (turns + 1));
    const turnUsage = {
      inputTokens: inputShares[turn],
      outputTokens: outputShares[turn],
      costUsd: costs[turn],
    };
    if (cacheShares) turnUsage.cacheReadTokens = cacheShares[turn];
    steps.push(
      step(at, {
        type: 'model.response',
        native: 'assistant/usage',
        confidence: 'observed',
        payload: { model, stopReason: turn === turns - 1 ? 'end_turn' : 'tool_use', usage: turnUsage },
      }),
    );
  }

  const finalAt = spanMs + 7000;
  steps.push(
    step(finalAt, {
      type: 'agent.output',
      native: 'result',
      confidence: 'observed',
      payload: { role: 'assistant', text: finalText, final: true },
    }),
    step(finalAt, {
      type: 'model.response',
      native: 'result/usage',
      confidence: 'observed',
      payload: { model, stopReason: 'end_turn', usage },
    }),
  );

  steps.sort((a, b) => a.atMs - b.atMs);
  return steps;
}

// ---- demo A: harness run ----------------------------------------------------------------------

function demoHarnessA() {
  const plan = [];
  for (let i = 0; i < 6; i += 1) plan.push({ kind: 'read', path: READ_TARGETS[i] });
  for (let i = 0; i < 24; i += 1) plan.push({ kind: 'filler' });
  plan.push({
    kind: 'bash',
    command: 'node --test',
    exitCode: 1,
    durationMs: 3100,
    output: TEST_FAIL_OUTPUT,
  });
  for (let i = 0; i < 9; i += 1) plan.push({ kind: 'filler' });
  plan.push({
    kind: 'task',
    subagent: 'test-repair-specialist',
    description: 'Confirm the expiry unit mismatch and propose the minimal fix',
    durationMs: 41000,
    output: 'expiresAt is seconds; isExpired compares it with Date.now() milliseconds',
  });
  plan.push({
    kind: 'edit',
    path: 'src/auth/session.js',
    content: SESSION_FIXED,
    linesAdded: 3,
    linesRemoved: 1,
  });
  for (let i = 0; i < 8; i += 1) plan.push({ kind: 'filler' });
  plan.push({
    kind: 'write',
    path: 'test/session.regression.test.js',
    content: TEST_REGRESSION,
    linesAdded: 14,
    linesRemoved: 0,
  });
  for (let i = 0; i < 10; i += 1) plan.push({ kind: 'filler' });
  plan.push({
    kind: 'bash',
    command: 'node --test',
    exitCode: 0,
    durationMs: 3400,
    output: TEST_PASS_OUTPUT_4,
  });
  plan.push({ kind: 'filler' });

  if (plan.length !== 63) throw new Error(`demo-harness-a expects 63 tool calls, built ${plan.length}`);

  return {
    name: 'demo-harness-a',
    description:
      'Agnostic AI style run: reads six files, reproduces the failure, delegates the diagnosis to one specialist subagent, fixes src/auth/session.js and adds a regression test. 63 tool calls, 4m52s.',
    agentVersion: '2.1.278',
    model: 'claude-sonnet-4-6',
    steps: buildRun({
      plan,
      spanMs: 285_000,
      model: 'claude-sonnet-4-6',
      sessionId: 'fake-a-9f21c4e0',
      agentVersion: '2.1.278',
      turns: 14,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'Task'],
      usage: { inputTokens: 182_000, outputTokens: 9400, cacheReadTokens: 120_000, costUsd: 2.81 },
      finalText:
        'isExpired compared a seconds timestamp with Date.now() in milliseconds, so every fresh session looked expired. src/auth/session.js now converts seconds to milliseconds, and test/session.regression.test.js pins the boundary case. node --test: 4 passing, 0 failing.',
    }),
    result: {
      status: 'completed',
      exitCode: 0,
      finalResponse:
        'Fixed the seconds/milliseconds mismatch in isExpired and added test/session.regression.test.js. node --test: 4 passing, 0 failing.',
      usage: {
        inputTokens: 182_000,
        outputTokens: 9400,
        cacheReadTokens: 120_000,
        costUsd: 2.81,
      },
      turns: 14,
    },
  };
}

// ---- demo B: vanilla run ----------------------------------------------------------------------

function demoVanillaB() {
  const plan = [];
  for (let i = 0; i < 18; i += 1) plan.push({ kind: 'read', path: READ_TARGETS[i % READ_TARGETS.length] });
  for (let i = 0; i < 40; i += 1) plan.push({ kind: 'filler' });
  plan.push({
    kind: 'bash',
    command: 'node --test',
    exitCode: 1,
    durationMs: 3200,
    output: TEST_FAIL_OUTPUT,
    warning: 'node --test failed; retrying after inspecting the assertion',
  });
  for (let i = 0; i < 30; i += 1) plan.push({ kind: 'filler' });
  plan.push({
    kind: 'bash',
    command: 'node --test',
    exitCode: 1,
    durationMs: 3300,
    output: TEST_FAIL_OUTPUT,
    warning: 'node --test failed again; the comparison unit is wrong, not the assertion',
  });
  for (let i = 0; i < 20; i += 1) plan.push({ kind: 'filler' });
  plan.push({
    kind: 'edit',
    path: 'src/auth/session.js',
    content: SESSION_FIXED,
    linesAdded: 3,
    linesRemoved: 1,
  });
  plan.push({
    kind: 'bash',
    command: 'node --test',
    exitCode: 0,
    durationMs: 3400,
    output: TEST_PASS_OUTPUT,
  });
  plan.push({
    kind: 'edit',
    path: 'test/session.test.js',
    content: TEST_EXTENDED,
    linesAdded: 4,
    linesRemoved: 0,
  });
  plan.push({
    kind: 'edit',
    path: 'README.md',
    content: README_WITH_NOTE,
    linesAdded: 4,
    linesRemoved: 0,
  });
  plan.push({
    kind: 'bash',
    command: 'node --test',
    exitCode: 0,
    durationMs: 3500,
    output: TEST_PASS_OUTPUT_3,
  });
  for (let i = 0; i < 32; i += 1) plan.push({ kind: 'filler' });

  if (plan.length !== 147) throw new Error(`demo-vanilla-b expects 147 tool calls, built ${plan.length}`);

  return {
    name: 'demo-vanilla-b',
    description:
      'Vanilla Claude Code style run on the same task: 18 file reads (several irrelevant), four test runs with two failures before success, no subagent, three files edited including an unrelated README touch. 147 tool calls, 3m17s.',
    agentVersion: '2.1.278',
    model: 'claude-sonnet-4-6',
    steps: buildRun({
      plan,
      spanMs: 190_000,
      model: 'claude-sonnet-4-6',
      sessionId: 'fake-b-4c7ab812',
      agentVersion: '2.1.278',
      turns: 27,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'Task'],
      usage: { inputTokens: 391_000, outputTokens: 21_000, costUsd: 6.42 },
      finalText:
        'The expiry comparison mixed seconds and milliseconds. src/auth/session.js now multiplies by 1000, test/session.test.js covers the one-second boundary, and README.md documents the unit. node --test: 3 passing, 0 failing.',
    }),
    result: {
      status: 'completed',
      exitCode: 0,
      finalResponse:
        'Fixed isExpired, extended test/session.test.js and documented the expiry unit in README.md. node --test: 3 passing, 0 failing.',
      usage: { inputTokens: 391_000, outputTokens: 21_000, costUsd: 6.42 },
      turns: 27,
    },
  };
}

// ---- small fixtures ---------------------------------------------------------------------------

function quickSuccess() {
  return {
    name: 'quick-success',
    description: 'Five events and one file write, finishing in two seconds. Used by fast unit tests.',
    agentVersion: 'fake-1.0.0',
    model: 'fake-model-1',
    steps: [
      step(0, {
        type: 'agent.started',
        native: 'system/init',
        confidence: 'observed',
        payload: {
          sessionId: 'fake-quick-0001',
          model: 'fake-model-1',
          version: 'fake-1.0.0',
          tools: ['Write'],
        },
      }),
      step(400, {
        type: 'tool.called',
        native: 'assistant/tool_use',
        confidence: 'observed',
        payload: { toolId: 'toolu_001', name: 'Write', input: { file_path: 'NOTES.md' }, parentToolId: null },
      }),
      fsStep(400, 'write', 'NOTES.md', 'quick-success fixture wrote this file.\n'),
      step(400, {
        type: 'file.changed',
        native: 'assistant/tool_use:Write',
        confidence: 'observed',
        payload: { path: 'NOTES.md', kind: 'create', linesAdded: 1, linesRemoved: 0 },
      }),
      step(1500, {
        type: 'model.response',
        native: 'result/usage',
        confidence: 'observed',
        payload: {
          model: 'fake-model-1',
          stopReason: 'end_turn',
          usage: { inputTokens: 1200, outputTokens: 180, costUsd: 0.0042 },
        },
      }),
      step(2000, {
        type: 'agent.output',
        native: 'result',
        confidence: 'observed',
        payload: { role: 'assistant', text: 'Wrote NOTES.md.', final: true },
      }),
    ],
    result: {
      status: 'completed',
      exitCode: 0,
      finalResponse: 'Wrote NOTES.md.',
      usage: { inputTokens: 1200, outputTokens: 180, costUsd: 0.0042 },
      turns: 1,
    },
  };
}

function failure() {
  const message = 'ReferenceError: parseSession is not defined (src/auth/session.js:12)';
  return {
    name: 'failure',
    description: 'The run errors out and exits 1. Used for failure-path assertions.',
    agentVersion: 'fake-1.0.0',
    model: 'fake-model-1',
    steps: [
      step(0, {
        type: 'agent.started',
        native: 'system/init',
        confidence: 'observed',
        payload: {
          sessionId: 'fake-fail-0001',
          model: 'fake-model-1',
          version: 'fake-1.0.0',
          tools: ['Bash'],
        },
      }),
      step(500, {
        type: 'agent.output',
        native: 'assistant/text',
        confidence: 'observed',
        payload: { role: 'assistant', text: 'Reproducing the failure first.' },
      }),
      step(1200, {
        type: 'tool.called',
        native: 'assistant/tool_use',
        confidence: 'observed',
        payload: { toolId: 'toolu_001', name: 'Bash', input: { command: 'node --test' }, parentToolId: null },
      }),
      step(1200, {
        type: 'command.started',
        native: 'assistant/tool_use:Bash',
        confidence: 'observed',
        payload: { commandId: 'toolu_001', command: 'node --test' },
      }),
      step(3000, {
        type: 'command.completed',
        native: 'user/tool_result',
        confidence: 'observed',
        payload: { commandId: 'toolu_001', exitCode: 1, durationMs: 1800, output: message },
      }),
      step(3100, {
        type: 'error',
        native: 'result/error_during_execution',
        confidence: 'observed',
        payload: { code: 'unknown', message, fatal: true },
      }),
    ],
    result: {
      status: 'failed',
      exitCode: 1,
      finalResponse: null,
      usage: { inputTokens: 3400, outputTokens: 210, costUsd: 0.0111 },
      turns: 2,
      errorCode: 'unknown',
      errorMessage: message,
    },
  };
}

function timeout() {
  const steps = [
    step(0, {
      type: 'agent.started',
      native: 'system/init',
      confidence: 'observed',
      payload: {
        sessionId: 'fake-timeout-0001',
        model: 'fake-model-1',
        version: 'fake-1.0.0',
        tools: ['Grep'],
      },
    }),
  ];
  const marks = [30_000, 120_000, 300_000, 480_000, 600_000];
  marks.forEach((at, i) => {
    const toolId = `toolu_${String(i + 1).padStart(3, '0')}`;
    steps.push(
      step(at, {
        type: 'tool.called',
        native: 'assistant/tool_use',
        confidence: 'observed',
        payload: { toolId, name: 'Grep', input: { pattern: 'expiresAt' }, parentToolId: null },
      }),
      step(at + 100, {
        type: 'tool.result',
        native: 'user/tool_result',
        confidence: 'observed',
        payload: { toolId, name: 'Grep', ok: true, output: '3 matches' },
      }),
    );
  });
  steps.push(
    step(600_500, {
      type: 'agent.output',
      native: 'result',
      confidence: 'observed',
      payload: { role: 'assistant', text: 'Still searching after ten minutes.', final: true },
    }),
  );
  return {
    name: 'timeout',
    description:
      'A timeline that runs for ten minutes. With a small limits.timeoutMs the replay stops early and reports timed_out.',
    agentVersion: 'fake-1.0.0',
    model: 'fake-model-1',
    steps,
    result: {
      status: 'completed',
      exitCode: 0,
      finalResponse: 'Still searching after ten minutes.',
      usage: { inputTokens: 90_000, outputTokens: 1200, costUsd: 0.31 },
      turns: 6,
    },
  };
}

function interrupted() {
  const steps = [
    step(0, {
      type: 'agent.started',
      native: 'system/init',
      confidence: 'observed',
      payload: {
        sessionId: 'fake-interrupt-0001',
        model: 'fake-model-1',
        version: 'fake-1.0.0',
        tools: ['Read', 'Grep'],
      },
    }),
  ];
  for (let i = 0; i < 60; i += 1) {
    const at = (i + 1) * 5000;
    const toolId = `toolu_${String(i + 1).padStart(3, '0')}`;
    steps.push(
      step(at, {
        type: 'tool.called',
        native: 'assistant/tool_use',
        confidence: 'observed',
        payload: {
          toolId,
          name: 'Read',
          input: { file_path: READ_TARGETS[i % READ_TARGETS.length] },
          parentToolId: null,
        },
      }),
      step(at + 50, {
        type: 'tool.result',
        native: 'user/tool_result',
        confidence: 'observed',
        payload: { toolId, name: 'Read', ok: true, output: 'read' },
      }),
    );
  }
  return {
    name: 'interrupted',
    description:
      'A five-minute timeline used by abort tests: cancel mid-replay and the run reports interrupted.',
    agentVersion: 'fake-1.0.0',
    model: 'fake-model-1',
    steps,
    result: {
      status: 'completed',
      exitCode: 0,
      finalResponse: 'Read every file.',
      usage: { inputTokens: 45_000, outputTokens: 900, costUsd: 0.14 },
      turns: 12,
    },
  };
}

function usageLimit() {
  const message =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:11 PM.";
  return {
    name: 'usage-limit',
    description:
      'Mirrors the real Codex usage-limit capture: the provider refuses the run, so the side reports a provider limit rather than a loss.',
    agentVersion: 'fake-1.0.0',
    model: 'fake-model-1',
    steps: [
      step(0, {
        type: 'agent.started',
        native: 'thread.started',
        confidence: 'observed',
        payload: { sessionId: 'fake-limit-0001', model: 'fake-model-1', version: 'fake-1.0.0' },
      }),
      step(900, {
        type: 'limit.hit',
        native: 'error',
        confidence: 'observed',
        payload: { kind: 'provider_limit', detail: message },
      }),
      step(900, {
        type: 'error',
        native: 'turn.failed',
        confidence: 'observed',
        payload: { code: 'provider_limit', message, fatal: true },
      }),
    ],
    result: {
      status: 'failed',
      exitCode: 1,
      finalResponse: null,
      usage: null,
      turns: 0,
      errorCode: 'provider_limit',
      errorMessage: message,
    },
  };
}

// ---- write ------------------------------------------------------------------------------------

const fixtures = [
  demoHarnessA(),
  demoVanillaB(),
  quickSuccess(),
  failure(),
  timeout(),
  interrupted(),
  usageLimit(),
];

for (const fixture of fixtures) {
  const file = join(outDir, `${fixture.name}.json`);
  await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  const events = fixture.steps.filter((s) => s.event).length;
  const fsOps = fixture.steps.filter((s) => s.fs).length;
  console.log(
    `wrote ${fixture.name}.json: ${fixture.steps.length} steps, ${events} events, ${fsOps} file ops`,
  );
}
