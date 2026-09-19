import type { AdapterRegistry, Detection, Logger } from '@harness-arena/adapters';
import type { BattleRecord, BattleSpecInput } from '@harness-arena/protocol';
import type { RunBattleOptions, StateStore } from '@harness-arena/core';
import type { BattleRunner } from './runner.js';

/**
 * Everything a tool is allowed to touch. The server owns one of these; a tool never reaches for
 * process state, never reads credentials, and never spawns anything itself: `runBattle` from
 * @harness-arena/core is the only execution path.
 */
export interface ArenaMcpDeps {
  /** injected in tests; defaults to runBattle from @harness-arena/core */
  runBattle?: (input: BattleSpecInput, opts?: RunBattleOptions) => Promise<BattleRecord>;
  /** injected in tests; defaults to detectAgents from @harness-arena/adapters */
  detectAgents?: (
    registry: AdapterRegistry,
    env?: Record<string, string | undefined>,
  ) => Promise<Detection[]>;
  /** used only for GitHub harness inspection over the REST API */
  fetchImpl?: typeof fetch;
  /**
   * Directory of the bundled example harness, listed by arena_list_harnesses when it exists.
   * `null` disables the lookup; omitted uses the repository checkout next to this package.
   */
  exampleHarnessDir?: string | null;
}

export interface ArenaContext {
  readonly home: string;
  readonly store: StateStore;
  readonly registry: AdapterRegistry;
  readonly logger: Logger;
  readonly env: Record<string, string | undefined>;
  readonly deps: ArenaMcpDeps;
  readonly runner: BattleRunner;
  readonly signal: AbortSignal;
}
