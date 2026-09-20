import { z } from 'zod';

/** Prefixes make ids self-describing in logs, URLs and the database. */
export const ID_PREFIX = {
  battle: 'btl',
  run: 'run',
  event: 'evt',
  harness: 'hrn',
  harnessVersion: 'hvr',
  repository: 'rep',
  task: 'tsk',
  user: 'usr',
  device: 'dev',
  evaluation: 'evl',
  artifact: 'art',
  agent: 'agt',
  benchmark: 'bmk',
  benchmarkVersion: 'bmv',
  challenge: 'chl',
  experiment: 'exp',
  tournament: 'trn',
  tournamentMatch: 'tmt',
  bounty: 'bty',
  bountySubmission: 'bsb',
  component: 'cmp',
  lineage: 'lin',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  return out;
}

/** `btl_` + 16 lowercase base36 chars (~82 bits of entropy). Safe in URLs and file names. */
export function makeId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${randomChars(16)}`;
}

export function idSchema(kind: IdKind) {
  const prefix = ID_PREFIX[kind];
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-z]{8,32}$`), { message: `expected an id like ${prefix}_xxxxxxxx` });
}

export const battleIdSchema = idSchema('battle');
export const runIdSchema = idSchema('run');
export const eventIdSchema = idSchema('event');

export function isId(kind: IdKind, value: unknown): value is string {
  return idSchema(kind).safeParse(value).success;
}
