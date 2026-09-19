import { EVENT_TYPES, type ArenaEvent, type EventType, type Side } from '@harness-arena/protocol';
import { clampText, stripAnsi } from './ansi';

export type EventCategoryId =
  'lifecycle' | 'model' | 'tools' | 'files' | 'commands' | 'tests' | 'subagents' | 'problems';

export interface EventCategory {
  id: EventCategoryId;
  label: string;
  types: readonly EventType[];
}

/** Every EventType belongs to exactly one category (asserted in test/events.test.ts). */
export const EVENT_CATEGORIES: readonly EventCategory[] = [
  {
    id: 'lifecycle',
    label: 'Lifecycle',
    types: [
      'battle.started',
      'battle.completed',
      'run.started',
      'run.completed',
      'agent.started',
      'evaluation.started',
      'evaluation.completed',
    ],
  },
  {
    id: 'model',
    label: 'Model',
    types: ['model.request', 'model.response', 'agent.output', 'agent.thinking'],
  },
  { id: 'tools', label: 'Tools', types: ['tool.called', 'tool.result'] },
  { id: 'files', label: 'Files', types: ['file.read', 'file.changed'] },
  { id: 'commands', label: 'Commands', types: ['command.started', 'command.completed'] },
  { id: 'tests', label: 'Tests', types: ['test.started', 'test.completed'] },
  { id: 'subagents', label: 'Subagents', types: ['subagent.spawned', 'subagent.completed'] },
  {
    id: 'problems',
    label: 'Problems',
    types: ['warning', 'error', 'interrupt', 'limit.hit', 'human.intervention', 'context.compacted'],
  },
];

const CATEGORY_BY_TYPE: Record<string, EventCategoryId> = (() => {
  const out: Record<string, EventCategoryId> = {};
  for (const category of EVENT_CATEGORIES) for (const type of category.types) out[type] = category.id;
  return out;
})();

export function categoryOf(type: EventType | string): EventCategoryId {
  return CATEGORY_BY_TYPE[type] ?? 'lifecycle';
}

export function categoryLabel(id: EventCategoryId): string {
  return EVENT_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/** Counts per category, for the filter chips. */
export function countByCategory(events: readonly ArenaEvent[]): Record<EventCategoryId, number> {
  const out = {
    lifecycle: 0,
    model: 0,
    tools: 0,
    files: 0,
    commands: 0,
    tests: 0,
    subagents: 0,
    problems: 0,
  } satisfies Record<EventCategoryId, number>;
  for (const event of events) out[categoryOf(event.type)] += 1;
  return out;
}

export function groupByCategory(events: readonly ArenaEvent[]): Record<EventCategoryId, ArenaEvent[]> {
  const out: Record<EventCategoryId, ArenaEvent[]> = {
    lifecycle: [],
    model: [],
    tools: [],
    files: [],
    commands: [],
    tests: [],
    subagents: [],
    problems: [],
  };
  for (const event of events) out[categoryOf(event.type)].push(event);
  return out;
}

export function isProblem(event: ArenaEvent): boolean {
  return categoryOf(event.type) === 'problems';
}

export function eventsForSide(events: readonly ArenaEvent[], side: Side): ArenaEvent[] {
  return events.filter((e) => e.side === side);
}

/**
 * A short, human-readable line for one event. ANSI is stripped and long text clamped, because this
 * string goes straight into the event log and the timeline.
 */
export function eventSummary(event: ArenaEvent, maxLength = 160): string {
  const text = describe(event);
  return clampText(stripAnsi(text).replace(/\s+/g, ' ').trim(), maxLength).text;
}

function describe(event: ArenaEvent): string {
  switch (event.type) {
    case 'battle.started':
      return `${event.payload.title} - A: ${event.payload.a.label} vs B: ${event.payload.b.label}`;
    case 'battle.completed':
      return `Battle ${event.payload.status}${event.payload.winner ? `, winner ${event.payload.winner}` : ''}`;
    case 'run.started':
      return `Run started: ${event.payload.agent}${event.payload.model ? ` (${event.payload.model})` : ''} on harness ${event.payload.harness}`;
    case 'run.completed':
      return `Run ${event.payload.status}, exit ${event.payload.exitCode ?? 'null'}`;
    case 'agent.started':
      return `Agent session started${event.payload.model ? `: ${event.payload.model}` : ''}`;
    case 'agent.output':
      return event.payload.text;
    case 'agent.thinking':
      return `Thinking (${event.payload.chars} chars)`;
    case 'model.request':
      return `Model request${event.payload.turn !== undefined ? ` (turn ${event.payload.turn})` : ''}`;
    case 'model.response': {
      const usage = event.payload.usage;
      const tokens = usage?.totalTokens ?? usage?.outputTokens;
      return `Model response${event.payload.stopReason ? ` (${event.payload.stopReason})` : ''}${tokens ? `, ${tokens} tokens` : ''}`;
    }
    case 'tool.called':
      return `${event.payload.name}${event.payload.summary ? `: ${event.payload.summary}` : ''}`;
    case 'tool.result':
      return `${event.payload.name ?? 'tool'} ${event.payload.ok ? 'ok' : 'failed'}${event.payload.output ? `: ${event.payload.output}` : ''}`;
    case 'command.started':
      return `$ ${event.payload.command}`;
    case 'command.completed':
      return `exit ${event.payload.exitCode ?? 'null'}${event.payload.output ? `: ${event.payload.output}` : ''}`;
    case 'file.read':
      return `Read ${event.payload.path}`;
    case 'file.changed':
      return `${event.payload.kind} ${event.payload.path} (+${event.payload.linesAdded ?? 0}/-${event.payload.linesRemoved ?? 0})`;
    case 'subagent.spawned':
      return `Subagent ${event.payload.name ?? event.payload.subagentId}${event.payload.description ? `: ${event.payload.description}` : ''}`;
    case 'subagent.completed':
      return `Subagent ${event.payload.subagentId} ${event.payload.status}`;
    case 'test.started':
      return `Tests (${event.payload.phase}) started: ${event.payload.command}`;
    case 'test.completed':
      return `Tests (${event.payload.phase}): ${event.payload.passed ?? '?'} passed, ${event.payload.failed ?? '?'} failed`;
    case 'context.compacted':
      return `Context compacted${event.payload.trigger ? ` (${event.payload.trigger})` : ''}`;
    case 'limit.hit':
      return `Limit hit: ${event.payload.kind}${event.payload.detail ? ` - ${event.payload.detail}` : ''}`;
    case 'human.intervention':
      return `Human ${event.payload.kind}${event.payload.detail ? `: ${event.payload.detail}` : ''}`;
    case 'evaluation.started':
      return `Evaluator ${event.payload.evaluatorId} started`;
    case 'evaluation.completed':
      return `Evaluator ${event.payload.evaluatorId}: ${event.payload.status} - ${event.payload.summary}`;
    case 'warning':
      return event.payload.message;
    case 'error':
      return `${event.payload.fatal ? 'Fatal: ' : ''}${event.payload.message}`;
    case 'interrupt':
      return `Interrupted (${event.payload.reason})${event.payload.detail ? `: ${event.payload.detail}` : ''}`;
    default:
      return (event as ArenaEvent).type;
  }
}

/** Free-text search across type, summary and native source. */
export function matchesQuery(event: ArenaEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    event.type.toLowerCase().includes(q) ||
    (event.source.native ?? '').toLowerCase().includes(q) ||
    eventSummary(event, 400).toLowerCase().includes(q)
  );
}

export const ALL_EVENT_TYPES: readonly EventType[] = EVENT_TYPES;
