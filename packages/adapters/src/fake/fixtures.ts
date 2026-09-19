import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EVENT_TYPES, eventConfidenceSchema, eventPayloads } from '@harness-arena/protocol';

/**
 * The fake adapter replays a fixture script: a timeline of protocol events and file-system
 * operations. It never spawns an agent CLI, so tests and the demo cost nothing.
 */

const eventMembers = EVENT_TYPES.map((type) =>
  z.object({
    type: z.literal(type),
    // Payload schemas come straight from the protocol package, so a fixture cannot drift from it.
    payload: eventPayloads[type] as z.ZodType,
    native: z.string().optional(),
    confidence: eventConfidenceSchema.optional(),
  }),
);

type EventMember = (typeof eventMembers)[number];

/** A protocol event without the envelope fields the core assigns (ids, seq, timestamps). */
export const fakeEventSchema = z.discriminatedUnion('type', eventMembers as [EventMember, ...EventMember[]]);

function isWorkspaceRelative(value: string): boolean {
  if (!value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('\\\\')) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === '..');
}

export const fakeFsOpSchema = z.object({
  op: z.enum(['write', 'append', 'delete', 'mkdir']),
  path: z
    .string()
    .min(1)
    .refine(isWorkspaceRelative, 'path must be workspace-relative and must not contain ".." segments'),
  content: z.string().optional(),
});
export type FakeFsOp = z.infer<typeof fakeFsOpSchema>;

export const fakeStepSchema = z.object({
  /** milliseconds after the run started; drives the deterministic tOffsets in the report */
  atMs: z.number().int().nonnegative(),
  event: fakeEventSchema.optional(),
  fs: fakeFsOpSchema.optional(),
  /** extra pause honoured only in realtime mode */
  sleepMs: z.number().int().nonnegative().optional(),
});
export type FakeStep = z.infer<typeof fakeStepSchema>;

export const fakeUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});

export const fakeResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'timed_out', 'interrupted']),
  exitCode: z.number().int().nullable(),
  finalResponse: z.string().nullable(),
  usage: fakeUsageSchema.nullable(),
  turns: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});

export const fakeScriptSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  agentVersion: z.string().min(1),
  model: z.string().nullable().optional(),
  steps: z.array(fakeStepSchema),
  result: fakeResultSchema,
});
export type FakeScript = z.infer<typeof fakeScriptSchema>;

/**
 * Builtin fixtures ship with the package. `../../fixtures/fake/` resolves identically from `src`
 * (vitest) and from `dist` (published build), because dist mirrors src one level deep.
 */
// path.resolve rather than new URL(): a bundler (Turbopack in apps/web) treats new URL(x, import.meta.url)
// as a static asset to resolve at build time and fails on a directory.
const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_FIXTURE_DIR = path.resolve(here, '..', '..', 'fixtures', 'fake') + path.sep;
/** The initial project the demo fixtures start from (committed into a throwaway repo by `arena demo`). */
export const FAKE_DEMO_PROJECT_DIR = path.resolve(FAKE_FIXTURE_DIR, 'demo-project') + path.sep;

const BUILTIN_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Resolve a builtin fixture name or an absolute path to a fixture file. */
export function resolveFakeFixturePath(nameOrPath: string): string {
  if (path.isAbsolute(nameOrPath)) return nameOrPath;
  if (!BUILTIN_NAME.test(nameOrPath)) {
    throw new Error(
      `fake fixture "${nameOrPath}" must be a builtin name (lowercase, digits, dashes) or an absolute path`,
    );
  }
  return path.join(FAKE_FIXTURE_DIR, `${nameOrPath}.json`);
}

export async function loadFakeFixture(nameOrPath: string): Promise<FakeScript> {
  const file = resolveFakeFixturePath(nameOrPath);
  const raw = await readFile(file, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `fake fixture ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = fakeScriptSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`fake fixture ${file} is invalid: ${problems}`);
  }
  return parsed.data;
}

/** Names of the builtin fixtures, sorted. */
export async function listFakeFixtures(): Promise<string[]> {
  const entries = await readdir(FAKE_FIXTURE_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort();
}
