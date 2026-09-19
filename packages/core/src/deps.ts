import type { AdapterRegistry, AgentAdapter, ProcessRunner } from '@harness-arena/adapters';
import type {
  ApplyHarnessFn,
  DescribeExecutionFn,
  DecideVerdictFn,
  EvaluateBattleFn,
  ResolveHarnessFn,
  RunTestsFn,
} from './ports.js';

/**
 * The engine's siblings are loaded lazily, by package name, the first time a battle actually needs
 * them. Two reasons: a battle that injects its own deps (tests, the demo, an embedder) never pays
 * for loading them, and a missing export produces one clear message instead of a stack trace from
 * inside an import graph.
 */

type SiblingPackage = 'adapters' | 'harness' | 'evaluator';

/**
 * Resolved at runtime, by name, from the workspace. The specifier is built rather than written as a
 * literal on purpose: core's own type-check must not depend on a sibling package compiling, and the
 * shapes these modules must satisfy are declared in ./ports.ts and checked at the call sites.
 */
async function load(pkg: SiblingPackage): Promise<Record<string, unknown>> {
  const specifier = '@harness-arena/' + pkg;
  try {
    const mod: unknown = await import(specifier);
    return mod as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      'could not load ' + specifier + ': ' + (err instanceof Error ? err.message : String(err)),
    );
  }
}

function pick<T>(mod: Record<string, unknown>, name: string, from: string): T {
  const value = mod[name];
  if (typeof value !== 'function') {
    throw new Error(from + ' does not export ' + name + '; upgrade it or pass the dependency explicitly');
  }
  return value as T;
}

export interface AdaptersModule {
  createRegistry(): AdapterRegistry;
  defaultProcessRunner: ProcessRunner;
  FakeAdapter: new (opts?: { realtime?: boolean }) => AgentAdapter;
}

export async function loadAdapters(): Promise<AdaptersModule> {
  const mod = await load('adapters');
  const runner = mod.defaultProcessRunner as ProcessRunner | undefined;
  if (!runner || typeof runner.run !== 'function') {
    throw new Error('@harness-arena/adapters does not export defaultProcessRunner');
  }
  return {
    createRegistry: pick<() => AdapterRegistry>(mod, 'createRegistry', '@harness-arena/adapters'),
    defaultProcessRunner: runner,
    FakeAdapter: pick<AdaptersModule['FakeAdapter']>(mod, 'FakeAdapter', '@harness-arena/adapters'),
  };
}

export interface HarnessModule {
  resolveHarness: ResolveHarnessFn;
  applyHarness: ApplyHarnessFn;
  describeExecution: DescribeExecutionFn;
}

export async function loadHarness(): Promise<HarnessModule> {
  const mod = await load('harness');
  return {
    resolveHarness: pick<ResolveHarnessFn>(mod, 'resolveHarness', '@harness-arena/harness'),
    applyHarness: pick<ApplyHarnessFn>(mod, 'applyHarness', '@harness-arena/harness'),
    describeExecution: pick<DescribeExecutionFn>(mod, 'describeExecution', '@harness-arena/harness'),
  };
}

export interface EvaluatorModule {
  runTests: RunTestsFn;
  evaluateBattle: EvaluateBattleFn;
  decideVerdict: DecideVerdictFn;
}

export async function loadEvaluator(): Promise<EvaluatorModule> {
  const mod = await load('evaluator');
  return {
    runTests: pick<RunTestsFn>(mod, 'runTests', '@harness-arena/evaluator'),
    evaluateBattle: pick<EvaluateBattleFn>(mod, 'evaluateBattle', '@harness-arena/evaluator'),
    decideVerdict: pick<DecideVerdictFn>(mod, 'decideVerdict', '@harness-arena/evaluator'),
  };
}
