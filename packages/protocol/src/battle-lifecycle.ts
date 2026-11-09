import { battleStatusSchema, type BattleStatus } from './events.js';

/**
 * The battle lifecycle, in one table. Every writer of a battle status (the engine, the database upsert,
 * the REST routes, the MCP handle, `arena doctor --fix`) checks this table; every reader that needs
 * "is it finished" or "is it live" derives the answer from it.
 *
 * Rules:
 * - forward only: an edge always points later in BATTLE_STATUSES order, so there are no cycles;
 * - skips are allowed: the server is a lossy mirror that usually sees `pending` and then the final status;
 * - terminal is final: completed, failed and cancelled have no outgoing edges;
 * - writing the current status again is an accepted no-op (a visibility PATCH, a retry, a re-seed).
 */

/** The stored values, in lifecycle order (the `battle_status` enum). */
export const BATTLE_STATUSES = battleStatusSchema.options;

/** Every battle starts here, whoever creates it. */
export const BATTLE_INITIAL_STATUS = 'pending' as const satisfies BattleStatus;

export const BATTLE_TRANSITIONS: Record<BattleStatus, readonly BattleStatus[]> = {
  pending: ['preparing', 'running', 'evaluating', 'completed', 'failed', 'cancelled'],
  preparing: ['running', 'evaluating', 'completed', 'failed', 'cancelled'],
  running: ['evaluating', 'completed', 'failed', 'cancelled'],
  evaluating: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Human labels for badges and messages. */
export const BATTLE_STATUS_LABELS: Record<BattleStatus, string> = {
  pending: 'Waiting to run',
  preparing: 'Preparing',
  running: 'Running',
  evaluating: 'Evaluating',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Statuses with no outgoing edges: the battle is finished. */
export const TERMINAL_BATTLE_STATUSES: readonly BattleStatus[] = BATTLE_STATUSES.filter(
  (s) => BATTLE_TRANSITIONS[s].length === 0,
);

/** Statuses where a run is in progress: neither the initial nor a terminal status. */
export const LIVE_BATTLE_STATUSES: readonly BattleStatus[] = BATTLE_STATUSES.filter(
  (s) => s !== BATTLE_INITIAL_STATUS && BATTLE_TRANSITIONS[s].length > 0,
);

function isBattleStatus(status: string): status is BattleStatus {
  return (BATTLE_STATUSES as readonly string[]).includes(status);
}

export function isTerminalBattleStatus(status: string): boolean {
  return isBattleStatus(status) && BATTLE_TRANSITIONS[status].length === 0;
}

export function isLiveBattleStatus(status: string): boolean {
  return (LIVE_BATTLE_STATUSES as readonly string[]).includes(status);
}

/** The statuses `current` may move to. Excludes `current` itself (re-writing it is a no-op, not an edge). */
export function nextBattleStatuses(current: BattleStatus): readonly BattleStatus[] {
  return BATTLE_TRANSITIONS[current];
}

/** True when `current -> requested` is an edge, or the same status (an accepted no-op re-save). */
export function canTransitionBattle(current: BattleStatus, requested: BattleStatus): boolean {
  return current === requested || BATTLE_TRANSITIONS[current].includes(requested);
}

/** Every status a battle may be in for a write of `requested` to be accepted, `requested` included. */
export function priorBattleStatuses(requested: BattleStatus): readonly BattleStatus[] {
  return BATTLE_STATUSES.filter((c) => canTransitionBattle(c, requested));
}

export class IllegalTransitionError extends Error {
  readonly code = 'illegal_transition' as const;
  readonly current: BattleStatus;
  readonly requested: BattleStatus;
  readonly allowed: readonly BattleStatus[];

  constructor(current: BattleStatus, requested: BattleStatus, subject = 'battle') {
    const allowed = nextBattleStatuses(current);
    const why =
      allowed.length === 0 ? `${current} is final` : `${current} can only become ${allowed.join(', ')}`;
    super(`${subject}: ${current} cannot become ${requested}; ${why}`);
    this.name = 'IllegalTransitionError';
    this.current = current;
    this.requested = requested;
    this.allowed = allowed;
  }
}

/** Throws IllegalTransitionError unless `current -> requested` is allowed (same status is allowed). */
export function assertBattleTransition(
  current: BattleStatus,
  requested: BattleStatus,
  subject?: string,
): void {
  if (!canTransitionBattle(current, requested)) {
    throw new IllegalTransitionError(current, requested, subject);
  }
}
