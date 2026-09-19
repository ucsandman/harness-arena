import type { AdapterEvent, Usage } from '@harness-arena/protocol';
import type { AdapterResult, AdapterRunStatus, StreamParser } from '../types.js';
import {
  addUsage,
  asRecord,
  classifyError,
  parseJsonLine,
  readNumber,
  readRecord,
  readString,
  textOf,
  truncateText,
  truncateValue,
} from '../shared.js';

/**
 * Translates `opencode run --format json` JSONL into protocol events.
 *
 * Documented line types: {type:'text', part:{text}},
 * {type:'tool_use', part:{tool, state:{status, input, output, title}}}, {type:'step_start'},
 * {type:'step_finish', part:{tokens:{input, output, reasoning, cache:{read, write}}, cost}},
 * {type:'error', error:{...}}.
 *
 * The failure path is verified against fixtures/opencode/provider-error.ndjson (OpenCode 2.0.4);
 * the success path against fixtures/opencode/synthetic-success.ndjson, built from that document.
 */

const DONE_STATUSES = new Set(['completed', 'error', 'failed']);

export class OpenCodeParser implements StreamParser {
  private sessionId: string | null = null;
  private usage: Usage | null = null;
  private steps = 0;
  private finalResponse: string | null = null;
  private status: AdapterRunStatus | undefined;
  private errorCode: string | null = null;
  private errorMessage: string | null = null;
  private toolSeq = 0;
  private readonly calledTools = new Set<string>();
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
    if (this.sessionId === null) this.sessionId = readString(record, 'sessionID') ?? null;
    const part = readRecord(record, 'part');

    switch (readString(record, 'type')) {
      case 'text': {
        const text = readString(part, 'text') ?? '';
        if (!text) return [];
        this.finalResponse = text;
        const t = truncateText(text);
        return [
          {
            type: 'agent.output',
            native: 'text',
            confidence: 'observed',
            payload: { role: 'assistant', text: t.text, truncated: t.truncated },
          },
        ];
      }
      case 'tool_use':
        return this.onToolUse(part);
      case 'step_start':
        return [{ type: 'model.request', native: 'step_start', confidence: 'observed', payload: {} }];
      case 'step_finish':
        return this.onStepFinish(part);
      case 'error': {
        const errorRecord = readRecord(record, 'error');
        const message =
          readString(errorRecord, 'message') ?? readString(errorRecord, 'type') ?? textOf(record.error);
        return this.onFatal(message, 'error');
      }
      default:
        return [];
    }
  }

  finish(): { events: AdapterEvent[]; result: Partial<AdapterResult> } {
    if (!this.errorMessage && this.status === 'failed') {
      const tail = this.stderrTail.join('\n');
      if (tail) {
        this.errorMessage = tail;
        this.errorCode = classifyError(tail);
      }
    }
    const result: Partial<AdapterResult> = {
      usage: this.usage,
      model: null,
      turns: this.steps > 0 ? this.steps : null,
      finalResponse: this.finalResponse,
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
      native: { sessionId: this.sessionId, steps: this.steps },
    };
    if (this.status) result.status = this.status;
    return { events: [], result };
  }

  private onToolUse(part: Record<string, unknown> | null): AdapterEvent[] {
    if (!part) return [];
    const name = readString(part, 'tool') ?? 'unknown';
    const toolId = readString(part, 'callID') ?? readString(part, 'id') ?? `${name}_${++this.toolSeq}`;
    const state = readRecord(part, 'state');
    const status = (readString(state, 'status') ?? 'running').toLowerCase();
    const events: AdapterEvent[] = [];

    if (!this.calledTools.has(toolId)) {
      this.calledTools.add(toolId);
      const input = truncateValue(state?.input ?? null);
      const title = readString(state, 'title');
      events.push({
        type: 'tool.called',
        native: `tool_use/${status}`,
        confidence: 'observed',
        payload: {
          toolId,
          name,
          input: input.value,
          ...(title ? { summary: truncateText(title, 500).text } : {}),
        },
      });
    }

    if (DONE_STATUSES.has(status)) {
      const output = truncateText(textOf(state?.output));
      events.push({
        type: 'tool.result',
        native: `tool_use/${status}`,
        confidence: 'observed',
        payload: {
          toolId,
          name,
          ok: status === 'completed',
          output: output.text,
          truncated: output.truncated,
        },
      });
    }
    return events;
  }

  private onStepFinish(part: Record<string, unknown> | null): AdapterEvent[] {
    this.steps += 1;
    const tokens = readRecord(part, 'tokens');
    const cache = readRecord(tokens, 'cache');
    const usage: Usage = {};
    const input = readNumber(tokens, 'input');
    if (input !== undefined) usage.inputTokens = input;
    const output = readNumber(tokens, 'output');
    if (output !== undefined) usage.outputTokens = output;
    const cacheRead = readNumber(cache, 'read');
    if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
    const cacheWrite = readNumber(cache, 'write');
    if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
    const cost = readNumber(part, 'cost');
    if (cost !== undefined) usage.costUsd = cost;
    if (Object.keys(usage).length === 0) return [];
    this.usage = addUsage(this.usage, usage);
    return [{ type: 'model.response', native: 'step_finish', confidence: 'observed', payload: { usage } }];
  }

  private onFatal(message: string | undefined, native: string): AdapterEvent[] {
    const text = message && message.length > 0 ? message : 'opencode reported a fatal error';
    const code = classifyError(text);
    this.status = 'failed';
    this.errorCode = code;
    this.errorMessage = text;
    const events: AdapterEvent[] = [];
    if (code === 'provider_limit') {
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
}
