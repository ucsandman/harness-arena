import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterEvent } from '@harness-arena/protocol';
import { buildChildEnv } from '../shared.js';
import type {
  AdapterCapabilities,
  AdapterResult,
  AgentAdapter,
  Detection,
  ExecuteContext,
  PrepareContext,
  PreparedRun,
  StreamParser,
  ValidationResult,
} from '../types.js';
import { loadFakeFixture } from './fixtures.js';
import type { FakeFsOp, FakeScript } from './fixtures.js';

/** The fixture reference travels from prepare() to execute() in the child environment. */
export const FAKE_FIXTURE_ENV = 'ARENA_FAKE_FIXTURE';
export const DEFAULT_FAKE_FIXTURE = 'quick-success';
export const FAKE_AGENT_VERSION = 'fake-1.0.0';

export interface FakeAdapterOptions {
  /** sleep between steps instead of replaying instantly (default false) */
  realtime?: boolean;
  /** realtime divisor: 2 replays twice as fast (default 1) */
  speed?: number;
  /** fixture used when the battle does not name one */
  fixture?: string;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function applyFsOp(root: string, op: FakeFsOp): Promise<void> {
  const workspace = path.resolve(root);
  const target = path.resolve(workspace, op.path);
  const rel = path.relative(workspace, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`fake fixture file operation escapes the workspace: ${op.path}`);
  }
  switch (op.op) {
    case 'mkdir':
      await mkdir(target, { recursive: true });
      return;
    case 'write':
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, op.content ?? '', 'utf8');
      return;
    case 'append':
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(target, op.content ?? '', 'utf8');
      return;
    case 'delete':
      await rm(target, { force: true, recursive: true });
      return;
  }
}

/** A parser that consumes nothing: the fake adapter emits events itself. */
class NullParser implements StreamParser {
  feed(): AdapterEvent[] {
    return [];
  }

  finish(): { events: AdapterEvent[]; result: Partial<AdapterResult> } {
    return { events: [], result: {} };
  }
}

/**
 * Deterministic adapter used by tests, the demo battle, and the report fixtures. It replays a
 * fixture timeline: events keep their offsets relative to the run start, and the declared file
 * operations really happen in the workspace, so git diff and the evaluators see a plausible patch.
 */
export class FakeAdapter implements AgentAdapter {
  readonly id = 'fake';
  readonly displayName = 'Fake agent (fixture replay)';
  readonly kind = 'fake' as const;
  readonly binaryNames = [] as const;

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  capabilities(): AdapterCapabilities {
    return {
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
      userConfigIsolation: true,
      stdinPrompt: true,
      notes: [
        'deterministic fixture replay: no model is called, nothing is spent, and the numbers come from the fixture',
      ],
    };
  }

  async detect(): Promise<Detection> {
    return {
      id: this.id,
      installed: true,
      path: null,
      version: FAKE_AGENT_VERSION,
      auth: 'ok',
      notes: ['built in; replays a fixture instead of calling a provider'],
    };
  }

  async validate(): Promise<ValidationResult> {
    return { ok: true, problems: [], warnings: [] };
  }

  async getVersion(): Promise<string | null> {
    return FAKE_AGENT_VERSION;
  }

  async prepare(ctx: PrepareContext): Promise<PreparedRun> {
    const fixture = ctx.fixture ?? this.options.fixture ?? DEFAULT_FAKE_FIXTURE;
    const { env, addedKeys } = buildChildEnv({
      base: ctx.env,
      agentConfig: ctx.agentConfig,
      agent: ctx.agent,
      runId: ctx.runId,
      side: ctx.side,
      workspace: ctx.workspace,
      harnessDir: ctx.harnessDir,
    });
    env[FAKE_FIXTURE_ENV] = fixture;

    ctx.logger.debug('prepared fake replay', { fixture, workspace: ctx.workspace });

    return {
      command: 'arena-fake',
      args: ['--fixture', fixture],
      env,
      cwd: ctx.workspace,
      stdin: ctx.task.prompt,
      disclosure: {
        command: 'arena-fake',
        args: ['--fixture', fixture],
        envKeysAdded: [...addedKeys, FAKE_FIXTURE_ENV].sort(),
        promptVia: 'stdin',
        notes: [
          'no process is spawned and no model is called: this adapter replays a recorded fixture',
          `fixture: ${fixture}`,
        ],
      },
      userConfigIsolated: true,
    };
  }

  async execute(prepared: PreparedRun, ctx: ExecuteContext): Promise<AdapterResult> {
    const reference = prepared.env[FAKE_FIXTURE_ENV] ?? this.options.fixture ?? DEFAULT_FAKE_FIXTURE;
    const script: FakeScript = await loadFakeFixture(reference);
    const log = ctx.logger.child({ adapter: this.id, fixture: script.name });
    const startedAt = Date.now();
    const realtime = this.options.realtime ?? false;
    const speed = this.options.speed && this.options.speed > 0 ? this.options.speed : 1;
    const timeoutMs = ctx.limits.timeoutMs;

    let stopped: 'abort' | 'timeout' | null = null;
    let lastAtMs = 0;
    let steps = 0;

    for (const step of script.steps) {
      if (ctx.signal.aborted) {
        stopped = 'abort';
        break;
      }
      if (timeoutMs > 0 && step.atMs > timeoutMs) {
        stopped = 'timeout';
        break;
      }
      if (realtime) {
        await sleep((Math.max(0, step.atMs - lastAtMs) + (step.sleepMs ?? 0)) / speed, ctx.signal);
        if (ctx.signal.aborted) {
          stopped = 'abort';
          break;
        }
      }
      lastAtMs = step.atMs;
      if (step.fs) await applyFsOp(prepared.cwd, step.fs);
      if (step.event) {
        // The schema was built from the protocol payload schemas, so the validated step is an event.
        ctx.emit({ ...step.event, at: startedAt + step.atMs } as AdapterEvent);
      }
      steps += 1;
    }

    const usage = script.result.usage ?? null;
    const base = {
      exitCode: script.result.exitCode,
      usage,
      model: script.model ?? null,
      version: script.agentVersion,
    };

    if (stopped === 'abort') {
      ctx.emit({ type: 'interrupt', payload: { reason: 'user' }, confidence: 'observed' });
      log.debug('fake replay aborted', { steps, lastAtMs });
      return {
        ...base,
        exitCode: null,
        status: 'interrupted',
        finalResponse: null,
        turns: null,
        errorCode: 'interrupted',
        errorMessage: 'run was aborted',
        durationMs: lastAtMs,
        native: { fixture: script.name, stepsReplayed: steps, lastAtMs },
      };
    }

    if (stopped === 'timeout') {
      ctx.emit({
        type: 'limit.hit',
        payload: { kind: 'timeout', detail: `fixture timeline exceeded ${timeoutMs}ms` },
        confidence: 'observed',
      });
      log.debug('fake replay timed out', { steps, lastAtMs, timeoutMs });
      return {
        ...base,
        exitCode: null,
        status: 'timed_out',
        finalResponse: null,
        turns: null,
        errorCode: 'timeout',
        errorMessage: `fixture timeline exceeded ${timeoutMs}ms`,
        durationMs: timeoutMs,
        native: { fixture: script.name, stepsReplayed: steps, lastAtMs },
      };
    }

    log.debug('fake replay finished', { steps, status: script.result.status });
    return {
      ...base,
      status: script.result.status,
      finalResponse: script.result.finalResponse,
      turns: script.result.turns,
      errorCode: script.result.errorCode ?? null,
      errorMessage: script.result.errorMessage ?? null,
      durationMs: lastAtMs,
      native: { fixture: script.name, description: script.description ?? null, stepsReplayed: steps },
    };
  }

  async cleanup(): Promise<void> {
    // Nothing to clean: the fixture only writes inside the workspace the core owns.
  }

  createParser(): StreamParser {
    return new NullParser();
  }
}
