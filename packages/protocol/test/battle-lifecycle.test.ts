import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BATTLE_INITIAL_STATUS,
  BATTLE_STATUSES,
  BATTLE_STATUS_LABELS,
  BATTLE_TRANSITIONS,
  IllegalTransitionError,
  LIVE_BATTLE_STATUSES,
  TERMINAL_BATTLE_STATUSES,
  assertBattleTransition,
  battleStatusSchema,
  canTransitionBattle,
  isLiveBattleStatus,
  isTerminalBattleStatus,
  nextBattleStatuses,
  priorBattleStatuses,
  type BattleStatus,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const initSql = path.resolve(here, '../../database/drizzle/0000_init.sql');

const pair = (edge: string): [BattleStatus, BattleStatus] => {
  const [from, to] = edge.split(' -> ').map((s) => battleStatusSchema.parse(s));
  return [from as BattleStatus, to as BattleStatus];
};

const ILLEGAL = [
  'completed -> pending',
  'completed -> preparing',
  'completed -> running',
  'completed -> evaluating',
  'completed -> failed',
  'completed -> cancelled',
  'failed -> pending',
  'failed -> preparing',
  'failed -> running',
  'failed -> evaluating',
  'failed -> completed',
  'failed -> cancelled',
  'cancelled -> pending',
  'cancelled -> preparing',
  'cancelled -> running',
  'cancelled -> evaluating',
  'cancelled -> completed',
  'cancelled -> failed',
  'evaluating -> pending',
  'evaluating -> preparing',
  'evaluating -> running',
  'running -> pending',
  'running -> preparing',
  'preparing -> pending',
];

const LEGAL = [
  'pending -> preparing',
  'pending -> running',
  'pending -> evaluating',
  'pending -> completed',
  'pending -> failed',
  'pending -> cancelled',
  'preparing -> running',
  'preparing -> evaluating',
  'preparing -> completed',
  'preparing -> failed',
  'preparing -> cancelled',
  'running -> evaluating',
  'running -> completed',
  'running -> failed',
  'running -> cancelled',
  'evaluating -> completed',
  'evaluating -> failed',
  'evaluating -> cancelled',
];

describe('battle lifecycle: illegal transitions are refused', () => {
  it.each(ILLEGAL)('%s', (edge) => {
    const [from, to] = pair(edge);
    expect(canTransitionBattle(from, to)).toBe(false);
    expect(nextBattleStatuses(from)).not.toContain(to);
    expect(() => assertBattleTransition(from, to)).toThrow(IllegalTransitionError);
  });
});

describe('battle lifecycle: legal transitions are accepted', () => {
  it.each(LEGAL)('%s', (edge) => {
    const [from, to] = pair(edge);
    expect(canTransitionBattle(from, to)).toBe(true);
    expect(nextBattleStatuses(from)).toContain(to);
    expect(() => assertBattleTransition(from, to)).not.toThrow();
  });
});

describe('battle lifecycle: re-writing the same status is an accepted no-op', () => {
  it.each([...BATTLE_STATUSES])('%s -> %s', (status) => {
    expect(canTransitionBattle(status, status)).toBe(true);
    expect(() => assertBattleTransition(status, status)).not.toThrow();
    // a no-op is not an edge: the status never lists itself as a next status
    expect(nextBattleStatuses(status)).not.toContain(status);
  });
});

describe('battle lifecycle: table invariants', () => {
  it('the table and the status list cover exactly the schema values', () => {
    const schema = [...battleStatusSchema.options].sort();
    expect(Object.keys(BATTLE_TRANSITIONS).sort()).toEqual(schema);
    expect([...BATTLE_STATUSES].sort()).toEqual(schema);
  });

  it('BATTLE_STATUSES equals the battle_status enum in the initial migration, in order', () => {
    const sql = fs.readFileSync(initSql, 'utf8');
    const match = /CREATE TYPE "public"\."battle_status" AS ENUM\(([^)]*)\)/.exec(sql);
    expect(match).not.toBeNull();
    const values = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values).toEqual([...BATTLE_STATUSES]);
  });

  it('every status is reachable from the initial status', () => {
    const seen = new Set<BattleStatus>([BATTLE_INITIAL_STATUS]);
    const queue: BattleStatus[] = [BATTLE_INITIAL_STATUS];
    while (queue.length > 0) {
      const at = queue.shift() as BattleStatus;
      for (const next of BATTLE_TRANSITIONS[at]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...BATTLE_STATUSES].sort());
  });

  it('the terminal statuses are exactly completed, failed and cancelled, each with no edges', () => {
    expect([...TERMINAL_BATTLE_STATUSES]).toEqual(['completed', 'failed', 'cancelled']);
    for (const status of TERMINAL_BATTLE_STATUSES) {
      expect(BATTLE_TRANSITIONS[status]).toEqual([]);
      expect(isTerminalBattleStatus(status)).toBe(true);
    }
    expect(isTerminalBattleStatus('nope')).toBe(false);
  });

  it('every non-terminal status reaches a terminal one', () => {
    for (const start of BATTLE_STATUSES) {
      if (isTerminalBattleStatus(start)) continue;
      const seen = new Set<BattleStatus>();
      const queue: BattleStatus[] = [start];
      while (queue.length > 0) {
        const at = queue.shift() as BattleStatus;
        for (const next of BATTLE_TRANSITIONS[at]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(
        [...seen].some((s) => isTerminalBattleStatus(s)),
        start,
      ).toBe(true);
    }
  });

  it('has no self-edges and every edge points later in lifecycle order (no cycles)', () => {
    for (const from of BATTLE_STATUSES) {
      for (const to of BATTLE_TRANSITIONS[from]) {
        expect(to).not.toBe(from);
        expect(BATTLE_STATUSES.indexOf(to), from + ' -> ' + to).toBeGreaterThan(
          BATTLE_STATUSES.indexOf(from),
        );
      }
    }
  });

  it('the live statuses are exactly preparing, running and evaluating', () => {
    expect([...LIVE_BATTLE_STATUSES]).toEqual(['preparing', 'running', 'evaluating']);
    for (const status of BATTLE_STATUSES) {
      expect(isLiveBattleStatus(status)).toBe(LIVE_BATTLE_STATUSES.includes(status));
    }
    expect(isLiveBattleStatus(BATTLE_INITIAL_STATUS)).toBe(false);
  });

  it('priorBattleStatuses(s) includes s and is every status that may move to s', () => {
    for (const requested of BATTLE_STATUSES) {
      const prior = priorBattleStatuses(requested);
      expect(prior).toContain(requested);
      expect([...prior].sort()).toEqual(
        BATTLE_STATUSES.filter((c) => canTransitionBattle(c, requested)).sort(),
      );
    }
  });

  it('every status has a non-empty label', () => {
    expect(Object.keys(BATTLE_STATUS_LABELS).sort()).toEqual([...BATTLE_STATUSES].sort());
    for (const status of BATTLE_STATUSES) {
      expect(BATTLE_STATUS_LABELS[status].trim().length).toBeGreaterThan(0);
    }
  });

  it('a refusal carries the code, the current and requested statuses, and what is still allowed', () => {
    const cases: Array<[BattleStatus, BattleStatus]> = [
      ['completed', 'running'],
      ['evaluating', 'preparing'],
    ];
    for (const [current, requested] of cases) {
      let caught: unknown;
      try {
        assertBattleTransition(current, requested, 'battle btl_x');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(IllegalTransitionError);
      const err = caught as IllegalTransitionError;
      expect(err.code).toBe('illegal_transition');
      expect(err.current).toBe(current);
      expect(err.requested).toBe(requested);
      expect(err.allowed).toEqual(nextBattleStatuses(current));
      expect(err.message).toContain('battle btl_x: ' + current + ' cannot become ' + requested);
    }
    expect(new IllegalTransitionError('completed', 'running', 'battle btl_x').message).toBe(
      'battle btl_x: completed cannot become running; completed is final',
    );
  });
});
