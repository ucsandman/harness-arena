import { arenaEventSchema, EVENT_LIMITS, EVENT_PROTOCOL_VERSION, makeId } from '@harness-arena/protocol';
import type { AdapterEvent, ArenaEvent, EventType, PrivacySettings, Side } from '@harness-arena/protocol';
import type { Redactor } from './redact.js';

/**
 * The single gate every event passes through on its way to disk or the network. It assigns identity
 * and ordering, enforces the privacy exclusions the user chose, caps sizes, and redacts secrets —
 * in that order, so nothing can skip a step by being emitted from an unusual place.
 */

export interface EventBusOptions {
  battleId: string;
  /** epoch ms of battle start; tOffsetMs is measured from here */
  startedAt: number;
  redactor: Redactor;
  privacy: PrivacySettings;
  /** durable sink (events.ndjson buffer) */
  sink: (event: ArenaEvent) => void;
  /** optional live observer (CLI spinner, uploader) */
  onEvent?: (event: ArenaEvent) => void;
  now?: () => number;
}

export interface EventBus {
  /** returns the stored event, or null when the privacy settings dropped it entirely */
  emit(side: Side | null, runId: string | null, adapter: string, event: AdapterEvent): ArenaEvent | null;
  /** events actually written */
  count(): number;
  /** last assigned sequence number */
  seq(): number;
}

/** Payload types that carry a `truncated` flag, so truncation is always visible in the UI. */
const TRUNCATABLE: ReadonlySet<EventType> = new Set<EventType>([
  'agent.output',
  'tool.result',
  'command.completed',
]);

/** Tools whose input or output is file content rather than a command. */
const FILE_WRITE_TOOL_RE =
  /^(write|edit|multiedit|notebookedit|apply_patch|str_replace(_based)?_edit_tool)$/i;
const FILE_READ_TOOL_RE = /^(read|view|notebookread|read_file)$/i;

const DROPPED = '[dropped: too large]';
const EXCLUDED = '[excluded]';

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  const cut = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  return { value: cut, truncated: true };
}

function truncateStrings(value: unknown, maxBytes: number, flag: { hit: boolean }): unknown {
  if (typeof value === 'string') {
    const r = truncateUtf8(value, maxBytes);
    if (r.truncated) flag.hit = true;
    return r.value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, maxBytes, flag));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = truncateStrings(v, maxBytes, flag);
    return out;
  }
  return value;
}

/** Replace the biggest payload fields with a marker until the serialized event fits. */
function enforceEventSize(event: ArenaEvent, maxBytes: number): ArenaEvent {
  let current = event;
  for (let guard = 0; guard < 16; guard++) {
    if (Buffer.byteLength(JSON.stringify(current), 'utf8') <= maxBytes) return current;
    const payload = current.payload as Record<string, unknown>;
    const biggest = Object.entries(payload)
      .filter(([, v]) => v !== DROPPED && (typeof v === 'string' || (v !== null && typeof v === 'object')))
      .map(([k, v]) => [k, JSON.stringify(v)?.length ?? 0] as const)
      .sort((x, y) => y[1] - x[1])[0];
    // Nothing left to shrink: the envelope alone is over the cap, which the caps make impossible.
    if (!biggest) return current;
    const next: Record<string, unknown> = { ...payload, [biggest[0]]: DROPPED };
    current = { ...current, payload: next } as unknown as ArenaEvent;
  }
  return current;
}

/** Returns the payload to store, or null when the whole event must be dropped. */
function applyPrivacy(
  type: EventType,
  payloadIn: Record<string, unknown>,
  exclude: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (exclude.size === 0) return payloadIn;
  const payload = { ...payloadIn };
  const toolName = typeof payload.name === 'string' ? payload.name : '';

  if (exclude.has('prompts')) {
    if (type === 'agent.output' && payload.role === 'user') return null;
    if (type === 'tool.called') delete payload.input;
  }
  if (exclude.has('model_outputs') && type === 'agent.output') {
    payload.text = EXCLUDED;
    payload.truncated = true;
  }
  if (exclude.has('command_output')) {
    if (type === 'command.completed') delete payload.output;
    if (type === 'tool.result') delete payload.output;
  }
  if (exclude.has('paths')) {
    if (type === 'run.started') delete payload.workspace;
    if (type === 'command.started') delete payload.cwd;
  }
  if (exclude.has('file_contents')) {
    if (type === 'tool.called' && FILE_WRITE_TOOL_RE.test(toolName)) delete payload.input;
    if (type === 'tool.result' && (FILE_READ_TOOL_RE.test(toolName) || FILE_WRITE_TOOL_RE.test(toolName))) {
      delete payload.output;
    }
  }
  return payload;
}

export function createEventBus(opts: EventBusOptions): EventBus {
  const exclude = new Set<string>(opts.privacy.exclude);
  const now = opts.now ?? (() => Date.now());
  let seq = 0;
  let written = 0;

  function deliver(event: ArenaEvent): ArenaEvent {
    written += 1;
    opts.sink(event);
    opts.onEvent?.(event);
    return event;
  }

  function envelope(
    side: Side | null,
    runId: string | null,
    adapter: string,
    type: EventType,
    payload: unknown,
    at: number,
    native: string | undefined,
    confidence: ArenaEvent['confidence'],
    assigned: number,
  ): ArenaEvent {
    return {
      v: EVENT_PROTOCOL_VERSION,
      id: makeId('event'),
      battleId: opts.battleId,
      runId,
      side,
      seq: assigned,
      ts: new Date(at).toISOString(),
      tOffsetMs: Math.max(0, at - opts.startedAt),
      source: native ? { adapter, native } : { adapter },
      confidence,
      type,
      payload,
    } as ArenaEvent;
  }

  return {
    emit(side, runId, adapter, event) {
      const assigned = (seq += 1);
      const at = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : now();
      const candidate = envelope(
        side,
        runId,
        adapter,
        event.type,
        event.payload,
        at,
        event.native,
        event.confidence ?? 'observed',
        assigned,
      );

      const parsed = arenaEventSchema.safeParse(candidate);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 4)
          .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
          .join('; ');
        const warning = envelope(
          side,
          runId,
          adapter,
          'warning',
          { code: 'event_invalid', message: 'dropped an invalid ' + event.type + ' event: ' + detail },
          at,
          event.native,
          'derived',
          assigned,
        );
        return deliver(opts.redactor.redactEvent(warning));
      }

      const normalized = parsed.data;
      const kept = applyPrivacy(normalized.type, normalized.payload as Record<string, unknown>, exclude);
      if (!kept) return null;

      const flag = { hit: false };
      const truncated = truncateStrings(kept, EVENT_LIMITS.maxStringBytes, flag) as Record<string, unknown>;
      if (flag.hit && TRUNCATABLE.has(normalized.type)) truncated.truncated = true;

      const withPayload = { ...normalized, payload: truncated } as ArenaEvent;
      const redacted = opts.privacy.redact ? opts.redactor.redactEvent(withPayload) : withPayload;
      return deliver(enforceEventSize(redacted, EVENT_LIMITS.maxEventBytes));
    },
    count: () => written,
    seq: () => seq,
  };
}
