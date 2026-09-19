import { z } from 'zod';
import { battleIdSchema, eventIdSchema, runIdSchema } from './ids.js';

export const EVENT_PROTOCOL_VERSION = 1 as const;

/**
 * How much to trust an event.
 * - observed:  the agent CLI reported it directly (source.native names the provider's own event type)
 * - derived:   Arena computed it from observed data (e.g. file.changed from a git diff after the run)
 * - estimated: a heuristic; the UI labels it
 */
export const eventConfidenceSchema = z.enum(['observed', 'derived', 'estimated']);
export type EventConfidence = z.infer<typeof eventConfidenceSchema>;

export const sideSchema = z.enum(['a', 'b']);
export type Side = z.infer<typeof sideSchema>;

export const runStatusSchema = z.enum([
  'pending',
  'preparing',
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'interrupted',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const battleStatusSchema = z.enum([
  'pending',
  'preparing',
  'running',
  'evaluating',
  'completed',
  'failed',
  'cancelled',
]);
export type BattleStatus = z.infer<typeof battleStatusSchema>;

/** Hard caps applied at ingest and before writing to disk. Oversized strings are truncated, never rejected. */
export const EVENT_LIMITS = {
  /** max bytes of any single string field inside a payload */
  maxStringBytes: 16 * 1024,
  /** max serialized bytes of one event */
  maxEventBytes: 64 * 1024,
  /** max events per upload batch */
  maxBatchEvents: 500,
  /** max events stored per battle (web ingest) */
  maxEventsPerBattle: 50_000,
} as const;

const limitedString = z.string().max(EVENT_LIMITS.maxStringBytes * 4);

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

// ---- payloads -------------------------------------------------------------------------------

export const eventPayloads = {
  'battle.started': z.object({
    title: z.string(),
    a: z.object({ label: z.string(), agent: z.string(), harness: z.string() }),
    b: z.object({ label: z.string(), agent: z.string(), harness: z.string() }),
    mode: z.enum(['local', 'local-byok', 'cloud']),
    demo: z.boolean().default(false),
  }),
  'battle.completed': z.object({
    status: battleStatusSchema,
    winner: z.enum(['a', 'b', 'tie', 'inconclusive']).optional(),
    durationMs: z.number().nonnegative(),
  }),
  'run.started': z.object({
    side: sideSchema,
    agent: z.string(),
    agentVersion: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    harness: z.string(),
    harnessCommit: z.string().nullable().optional(),
    /** Present only when privacy.exclude does not contain 'paths'. */
    workspace: z.string().optional(),
  }),
  'run.completed': z.object({
    side: sideSchema,
    status: runStatusSchema,
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative(),
    reason: z.string().optional(),
  }),
  'agent.started': z.object({
    sessionId: z.string().optional(),
    model: z.string().optional(),
    version: z.string().optional(),
    tools: z.array(z.string()).optional(),
    cwdKnown: z.boolean().optional(),
  }),
  'agent.output': z.object({
    role: z.enum(['assistant', 'system', 'user']),
    text: limitedString,
    truncated: z.boolean().optional(),
    final: z.boolean().optional(),
  }),
  'agent.thinking': z.object({ chars: z.number().int().nonnegative() }),
  'model.request': z.object({ model: z.string().optional(), turn: z.number().int().optional() }),
  'model.response': z.object({
    model: z.string().optional(),
    stopReason: z.string().optional(),
    usage: usageSchema.optional(),
  }),
  'tool.called': z.object({
    toolId: z.string(),
    name: z.string(),
    /** Redacted + truncated. Excluded entirely under privacy.exclude 'prompts'. */
    input: z.unknown().optional(),
    parentToolId: z.string().nullable().optional(),
    summary: z.string().optional(),
  }),
  'tool.result': z.object({
    toolId: z.string(),
    name: z.string().optional(),
    ok: z.boolean(),
    output: limitedString.optional(),
    truncated: z.boolean().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  'command.started': z.object({
    commandId: z.string(),
    command: limitedString,
    cwd: z.string().optional(),
  }),
  'command.completed': z.object({
    commandId: z.string(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative().optional(),
    output: limitedString.optional(),
    truncated: z.boolean().optional(),
  }),
  'file.read': z.object({ path: z.string(), bytes: z.number().int().nonnegative().optional() }),
  'file.changed': z.object({
    path: z.string(),
    kind: z.enum(['create', 'modify', 'delete', 'rename']),
    linesAdded: z.number().int().nonnegative().optional(),
    linesRemoved: z.number().int().nonnegative().optional(),
    from: z.string().optional(),
  }),
  'subagent.spawned': z.object({
    subagentId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
  }),
  'subagent.completed': z.object({
    subagentId: z.string(),
    status: z.enum(['completed', 'failed', 'killed']),
    durationMs: z.number().nonnegative().optional(),
  }),
  'test.started': z.object({ command: z.string(), phase: z.enum(['baseline', 'post']) }),
  'test.completed': z.object({
    command: z.string(),
    phase: z.enum(['baseline', 'post']),
    exitCode: z.number().int().nullable(),
    passed: z.number().int().nonnegative().nullable(),
    failed: z.number().int().nonnegative().nullable(),
    skipped: z.number().int().nonnegative().nullable().optional(),
    total: z.number().int().nonnegative().nullable(),
    durationMs: z.number().nonnegative(),
    parser: z.string(),
  }),
  'context.compacted': z.object({ trigger: z.string().optional() }),
  'limit.hit': z.object({
    kind: z.enum(['timeout', 'max_turns', 'max_budget', 'max_output', 'provider_limit', 'rate_limit']),
    detail: z.string().optional(),
  }),
  'human.intervention': z.object({
    kind: z.enum(['permission', 'input', 'unknown']),
    detail: z.string().optional(),
    /** true when Arena detected a blocking prompt and answered/aborted it automatically */
    automated: z.boolean().optional(),
  }),
  'evaluation.started': z.object({ evaluatorId: z.string(), side: sideSchema.nullable() }),
  'evaluation.completed': z.object({
    evaluatorId: z.string(),
    side: sideSchema.nullable(),
    status: z.enum(['passed', 'failed', 'skipped', 'error']),
    summary: z.string(),
  }),
  warning: z.object({ code: z.string().optional(), message: limitedString }),
  error: z.object({ code: z.string().optional(), message: limitedString, fatal: z.boolean() }),
  interrupt: z.object({ reason: z.enum(['user', 'timeout', 'signal', 'limit']), detail: z.string().optional() }),
} as const;

export type EventType = keyof typeof eventPayloads;
export const EVENT_TYPES = Object.keys(eventPayloads) as EventType[];
export const eventTypeSchema = z.enum(EVENT_TYPES as [EventType, ...EventType[]]);

export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloads)[T]>;

// ---- envelope --------------------------------------------------------------------------------

const envelopeBase = {
  v: z.literal(EVENT_PROTOCOL_VERSION),
  id: eventIdSchema,
  battleId: battleIdSchema,
  /** null for battle-level events */
  runId: runIdSchema.nullable(),
  side: sideSchema.nullable(),
  /** monotonic per battle; the web SSE stream and the report scrubber key on it */
  seq: z.number().int().nonnegative(),
  /** ISO 8601 */
  ts: z.string(),
  /** milliseconds since battle start (calculated); lets both runs be scrubbed on one axis */
  tOffsetMs: z.number().nonnegative(),
  source: z.object({
    /** adapter id ('claude-code', 'codex', 'gemini-cli', 'opencode', 'fake', 'arena') */
    adapter: z.string(),
    /** provider's native event/type name, when the event was translated from one */
    native: z.string().optional(),
  }),
  confidence: eventConfidenceSchema,
};

function member<T extends EventType>(type: T) {
  return z.object({ ...envelopeBase, type: z.literal(type), payload: eventPayloads[type] });
}

export const arenaEventSchema = z.discriminatedUnion('type', [
  member('battle.started'),
  member('battle.completed'),
  member('run.started'),
  member('run.completed'),
  member('agent.started'),
  member('agent.output'),
  member('agent.thinking'),
  member('model.request'),
  member('model.response'),
  member('tool.called'),
  member('tool.result'),
  member('command.started'),
  member('command.completed'),
  member('file.read'),
  member('file.changed'),
  member('subagent.spawned'),
  member('subagent.completed'),
  member('test.started'),
  member('test.completed'),
  member('context.compacted'),
  member('limit.hit'),
  member('human.intervention'),
  member('evaluation.started'),
  member('evaluation.completed'),
  member('warning'),
  member('error'),
  member('interrupt'),
]);

export type ArenaEvent = z.infer<typeof arenaEventSchema>;
export type ArenaEventOf<T extends EventType> = Extract<ArenaEvent, { type: T }>;

/**
 * What an adapter emits: the event minus the envelope fields Arena fills in (ids, seq, timestamps).
 * Adapters are pure translators; the core assigns identity and ordering.
 */
export type AdapterEvent = {
  [T in EventType]: {
    type: T;
    payload: EventPayload<T>;
    native?: string;
    confidence?: EventConfidence;
    /** adapter-local timestamp when known (ms epoch); core uses receive time otherwise */
    at?: number;
  };
}[EventType];

export const eventBatchSchema = z.object({
  events: z.array(arenaEventSchema).min(1).max(EVENT_LIMITS.maxBatchEvents),
});
export type EventBatch = z.infer<typeof eventBatchSchema>;

export function parseEvent(input: unknown): ArenaEvent {
  return arenaEventSchema.parse(input);
}

export function safeParseEvent(input: unknown) {
  return arenaEventSchema.safeParse(input);
}
