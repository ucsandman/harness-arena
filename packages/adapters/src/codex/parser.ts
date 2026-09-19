import type { AdapterEvent, Usage } from '@harness-arena/protocol';
import type { AdapterResult, AdapterRunStatus, StreamParser } from '../types.js';
import {
  addUsage,
  asRecord,
  classifyError,
  parseJsonLine,
  readArray,
  readNumber,
  readRecord,
  readString,
  truncateText,
  truncateValue,
} from '../shared.js';

/**
 * Translates `codex exec --json` JSONL into protocol events.
 *
 * Event shape per OpenAI's codex exec documentation: thread.started, turn.started,
 * item.started / item.updated / item.completed (item.type: agent_message, reasoning,
 * command_execution, file_change, mcp_tool_call, web_search, todo_list, error),
 * turn.completed{usage}, turn.failed{error}, error{message}.
 *
 * The failure path is verified against fixtures/codex/usage-limit.ndjson (codex-cli 0.154.0); the
 * success path against fixtures/codex/synthetic-success.ndjson, which is built from that document.
 */

const FILE_CHANGE_KINDS: Record<string, 'create' | 'delete' | 'modify'> = {
  add: 'create',
  delete: 'delete',
  update: 'modify',
};

interface ItemState {
  type: string;
  startedEmitted: boolean;
}

export class CodexParser implements StreamParser {
  private threadId: string | null = null;
  private usage: Usage | null = null;
  private turns = 0;
  private finalResponse: string | null = null;
  private status: AdapterRunStatus | undefined;
  private errorCode: string | null = null;
  private errorMessage: string | null = null;
  private lastFatal: string | null = null;
  private limitEmitted = false;
  private itemSeq = 0;
  private readonly items = new Map<string, ItemState>();
  private readonly stderrTail: string[] = [];

  feed(line: string, stream: 'stdout' | 'stderr' = 'stdout'): AdapterEvent[] {
    if (stream === 'stderr') {
      const trimmed = line.trim();
      if (trimmed) {
        this.stderrTail.push(trimmed);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
      return [];
    }
    const parsed = parseJsonLine(line);
    if (!parsed.ok) return [];
    const record = asRecord(parsed.value);
    if (!record) return [];

    switch (readString(record, 'type')) {
      case 'thread.started': {
        this.threadId = readString(record, 'thread_id') ?? null;
        return [
          {
            type: 'agent.started',
            native: 'thread.started',
            confidence: 'observed',
            payload: { ...(this.threadId ? { sessionId: this.threadId } : {}) },
          },
        ];
      }
      case 'turn.started':
        return [
          {
            type: 'model.request',
            native: 'turn.started',
            confidence: 'observed',
            payload: { turn: this.turns + 1 },
          },
        ];
      case 'item.started':
        return this.onItem(record, 'started');
      case 'item.updated':
        // interim state; the completed item carries the final values
        return [];
      case 'item.completed':
        return this.onItem(record, 'completed');
      case 'turn.completed':
        return this.onTurnCompleted(record);
      case 'turn.failed':
        return this.onFatal(readString(readRecord(record, 'error'), 'message'), 'turn.failed');
      case 'error':
        return this.onFatal(readString(record, 'message'), 'error');
      default:
        return [];
    }
  }

  finish(): { events: AdapterEvent[]; result: Partial<AdapterResult> } {
    if (!this.errorMessage) {
      const tail = this.stderrTail.join('\n');
      if (tail && this.status === 'failed') {
        this.errorCode = classifyError(tail);
        this.errorMessage = tail;
      }
    }
    const result: Partial<AdapterResult> = {
      usage: this.usage,
      // Codex does not report the model in its JSON stream; the adapter fills in what it requested.
      model: null,
      turns: this.turns > 0 ? this.turns : null,
      finalResponse: this.finalResponse,
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
      native: { threadId: this.threadId },
    };
    if (this.status) result.status = this.status;
    return { events: [], result };
  }

  private onTurnCompleted(record: Record<string, unknown>): AdapterEvent[] {
    this.turns += 1;
    const usageRecord = readRecord(record, 'usage');
    const usage: Usage = {};
    const input = readNumber(usageRecord, 'input_tokens');
    if (input !== undefined) usage.inputTokens = input;
    const cached = readNumber(usageRecord, 'cached_input_tokens');
    if (cached !== undefined) usage.cacheReadTokens = cached;
    const output = readNumber(usageRecord, 'output_tokens');
    if (output !== undefined) usage.outputTokens = output;
    if (Object.keys(usage).length === 0) return [];
    // Codex reports usage per turn; `codex exec` normally runs one turn, and several are summed.
    this.usage = addUsage(this.usage, usage);
    return [{ type: 'model.response', native: 'turn.completed', confidence: 'observed', payload: { usage } }];
  }

  private onFatal(message: string | undefined, native: string): AdapterEvent[] {
    const text = message ?? 'codex reported a fatal error';
    if (this.lastFatal === text) return []; // codex reports the same failure as `error` and `turn.failed`
    this.lastFatal = text;
    const code = classifyError(text);
    this.status = 'failed';
    this.errorCode = code;
    this.errorMessage = text;

    const events: AdapterEvent[] = [];
    if (code === 'provider_limit' && !this.limitEmitted) {
      this.limitEmitted = true;
      events.push({
        type: 'limit.hit',
        native,
        confidence: 'observed',
        payload: { kind: 'provider_limit', detail: truncateText(text).text },
      });
    }
    events.push({
      type: 'error',
      native,
      confidence: 'observed',
      payload: { code, message: truncateText(text).text, fatal: true },
    });
    return events;
  }

  private onItem(record: Record<string, unknown>, phase: 'started' | 'completed'): AdapterEvent[] {
    const item = readRecord(record, 'item');
    if (!item) return [];
    const type = readString(item, 'type') ?? 'unknown';
    const id = readString(item, 'id') ?? `item_${++this.itemSeq}`;
    const native = `item.${phase}:${type}`;
    const state = this.items.get(id) ?? { type, startedEmitted: false };
    this.items.set(id, state);
    const events: AdapterEvent[] = [];

    switch (type) {
      case 'command_execution': {
        const command = readString(item, 'command') ?? '';
        if (!state.startedEmitted) {
          state.startedEmitted = true;
          events.push({
            type: 'tool.called',
            native,
            confidence: 'observed',
            payload: {
              toolId: id,
              name: 'command_execution',
              input: { command: truncateText(command).text },
            },
          });
          events.push({
            type: 'command.started',
            native,
            confidence: 'observed',
            payload: { commandId: id, command: truncateText(command).text },
          });
        }
        if (phase === 'completed') {
          const exitCode = readNumber(item, 'exit_code');
          const status = readString(item, 'status');
          const output = truncateText(readString(item, 'aggregated_output') ?? '');
          const ok = exitCode !== undefined ? exitCode === 0 : status !== 'failed';
          events.push({
            type: 'command.completed',
            native,
            confidence: 'observed',
            payload: {
              commandId: id,
              exitCode: exitCode ?? null,
              output: output.text,
              truncated: output.truncated,
            },
          });
          events.push({
            type: 'tool.result',
            native,
            confidence: 'observed',
            payload: {
              toolId: id,
              name: 'command_execution',
              ok,
              output: output.text,
              truncated: output.truncated,
            },
          });
        }
        return events;
      }
      case 'file_change': {
        if (phase !== 'completed') return [];
        for (const raw of readArray(item, 'changes')) {
          const change = asRecord(raw);
          const filePath = readString(change, 'path');
          if (!filePath) continue;
          const kind = FILE_CHANGE_KINDS[readString(change, 'kind') ?? ''] ?? 'modify';
          events.push({
            type: 'file.changed',
            native,
            confidence: 'observed',
            payload: { path: filePath, kind },
          });
        }
        return events;
      }
      case 'agent_message': {
        if (phase !== 'completed') return [];
        const text = readString(item, 'text') ?? '';
        if (!text) return [];
        this.finalResponse = text;
        const t = truncateText(text);
        return [
          {
            type: 'agent.output',
            native,
            confidence: 'observed',
            payload: { role: 'assistant', text: t.text, truncated: t.truncated },
          },
        ];
      }
      case 'reasoning': {
        if (phase !== 'completed') return [];
        const text = readString(item, 'text') ?? '';
        return [{ type: 'agent.thinking', native, confidence: 'observed', payload: { chars: text.length } }];
      }
      case 'mcp_tool_call': {
        const name = `${readString(item, 'server') ?? 'mcp'}/${readString(item, 'tool') ?? 'tool'}`;
        if (!state.startedEmitted) {
          state.startedEmitted = true;
          const input = truncateValue(item.arguments ?? item.input ?? null);
          events.push({
            type: 'tool.called',
            native,
            confidence: 'observed',
            payload: { toolId: id, name, input: input.value },
          });
        }
        if (phase === 'completed') {
          events.push({
            type: 'tool.result',
            native,
            confidence: 'observed',
            payload: { toolId: id, name, ok: readString(item, 'status') !== 'failed' },
          });
        }
        return events;
      }
      case 'web_search': {
        if (phase !== 'completed') return [];
        const query = readString(item, 'query') ?? '';
        return [
          {
            type: 'tool.called',
            native,
            confidence: 'observed',
            payload: { toolId: id, name: 'web_search', input: { query: truncateText(query).text } },
          },
        ];
      }
      case 'error': {
        if (phase !== 'completed') return [];
        const message = readString(item, 'message') ?? 'codex reported an item error';
        return [
          {
            type: 'error',
            native,
            confidence: 'observed',
            payload: { code: classifyError(message), message: truncateText(message).text, fatal: false },
          },
        ];
      }
      default:
        // todo_list and future item types carry no metric Arena records.
        return [];
    }
  }
}
