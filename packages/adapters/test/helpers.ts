import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent, EventType, Limits } from '@harness-arena/protocol';
import type {
  AdapterResult,
  ExecuteContext,
  Logger,
  PrepareContext,
  ProcessRunner,
  StreamParser,
} from '../src/types';
import { createNoopLogger } from '../src/shared';

export const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));

export async function readFixture(relative: string): Promise<string> {
  return readFile(path.join(FIXTURE_ROOT, relative), 'utf8');
}

export interface ParsedFixture {
  events: AdapterEvent[];
  result: Partial<AdapterResult>;
  counts: Partial<Record<EventType, number>>;
}

/** Feed every line of a fixture through a parser, exactly as the process runner would. */
export function feedLines(
  parser: StreamParser,
  text: string,
  stream: 'stdout' | 'stderr' = 'stdout',
): ParsedFixture {
  const events: AdapterEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    events.push(...parser.feed(line, stream));
  }
  const finished = parser.finish();
  events.push(...finished.events);
  return { events, result: finished.result, counts: countByType(events) };
}

export function countByType(events: readonly AdapterEvent[]): Partial<Record<EventType, number>> {
  const counts: Partial<Record<EventType, number>> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

export function eventsOfType<T extends EventType>(
  events: readonly AdapterEvent[],
  type: T,
): Extract<AdapterEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AdapterEvent, { type: T }> => e.type === type);
}

export const TEST_LIMITS: Limits = {
  timeoutMs: 20 * 60_000,
  maxOutputBytes: 50 * 1024 * 1024,
};

export function testLogger(): Logger {
  return createNoopLogger();
}

/** A PATH that contains no agent CLI, so prepare() is deterministic on every machine. */
export function emptyPathEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    PATH: path.join(os.tmpdir(), 'harness-arena-empty-path'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    HOME: os.homedir(),
    ...extra,
  };
}

export function makePrepareContext(overrides: Partial<PrepareContext> = {}): PrepareContext {
  return {
    runId: 'run_testrun00000001',
    side: 'a',
    workspace: path.join(os.tmpdir(), 'arena-workspace'),
    harnessDir: path.join(os.tmpdir(), 'arena-harness'),
    agentConfig: null,
    agent: { id: 'claude-code' },
    fixture: null,
    task: {
      title: 'Fix the failing test',
      prompt: 'Fix the failing test in src/auth/session.js',
      source: { kind: 'prompt' },
    },
    limits: TEST_LIMITS,
    env: emptyPathEnv(),
    logger: testLogger(),
    ...overrides,
  };
}

export interface CapturedExecute {
  ctx: ExecuteContext;
  events: AdapterEvent[];
  controller: AbortController;
}

export function makeExecuteContext(runner: ProcessRunner, limits: Limits = TEST_LIMITS): CapturedExecute {
  const events: AdapterEvent[] = [];
  const controller = new AbortController();
  return {
    events,
    controller,
    ctx: {
      emit: (event) => events.push(event),
      signal: controller.signal,
      logger: testLogger(),
      limits,
      runner,
    },
  };
}

/** A ProcessRunner that replays canned lines instead of spawning anything. */
export function scriptedRunner(options: {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number | null;
  spawnError?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
}): ProcessRunner {
  return {
    run: async (opts) => {
      for (const line of options.stdout ?? []) opts.onStdoutLine(line);
      for (const line of options.stderr ?? []) opts.onStderrLine(line);
      return {
        exitCode: options.exitCode === undefined ? 0 : options.exitCode,
        signal: null,
        timedOut: options.timedOut ?? false,
        aborted: options.aborted ?? false,
        outputBytes: 0,
        truncated: false,
        durationMs: 12,
        spawnError: options.spawnError ?? null,
      };
    },
  };
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
