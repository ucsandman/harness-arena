import type { AdapterEvent, Usage } from '@harness-arena/protocol';
import type { AdapterResult, AdapterRunStatus, StreamParser } from '../types.js';
import {
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
 * Translates `gemini --output-format stream-json` JSONL into protocol events.
 *
 * Documented line types: init{session_id, model}, message{role, content},
 * tool_use{tool_name, tool_id, parameters}, tool_result{tool_id, status, output}, error{message},
 * result{status, stats{total_tokens, input_tokens, output_tokens, cached, duration_ms, tool_calls}}.
 *
 * Gemini CLI also writes plain prose to stdout/stderr (banners, hook noise, stack traces). Those
 * lines are not turned into events one by one; the first fatal-looking line becomes a single error
 * event and the text is kept for classification. Verified against
 * fixtures/gemini-cli/auth-error.txt (Gemini CLI 0.55.1).
 */

const FATAL_TEXT =
  /(?:^|:)\s*(?:an )?unexpected critical error occurred|error authenticating|ineligibletiererror/i;
const OK_TOOL_STATUS = new Set(['success', 'ok', 'completed', 'done']);

export class GeminiCliParser implements StreamParser {
  private sessionId: string | null = null;
  private model: string | null = null;
  private usage: Usage | null = null;
  private finalResponse: string | null = null;
  private resultStatus: string | null = null;
  private stats: unknown = null;
  private status: AdapterRunStatus | undefined;
  private errorCode: string | null = null;
  private errorMessage: string | null = null;
  private textErrorEmitted = false;
  private readonly textTail: string[] = [];

  feed(line: string, _stream: 'stdout' | 'stderr' = 'stdout'): AdapterEvent[] {
    const parsed = parseJsonLine(line);
    if (!parsed.ok) return this.onText(line);
    const record = asRecord(parsed.value);
    if (!record) return [];

    switch (readString(record, 'type')) {
      case 'init': {
        this.sessionId = readString(record, 'session_id') ?? null;
        this.model = readString(record, 'model') ?? null;
        return [
          {
            type: 'agent.started',
            native: 'init',
            confidence: 'observed',
            payload: {
              ...(this.sessionId ? { sessionId: this.sessionId } : {}),
              ...(this.model ? { model: this.model } : {}),
            },
          },
        ];
      }
      case 'message': {
        const role = readString(record, 'role') ?? 'assistant';
        const text = textOf(record.content);
        if (!text) return [];
        if (role === 'assistant') this.finalResponse = text;
        const t = truncateText(text);
        return [
          {
            type: 'agent.output',
            native: 'message',
            confidence: 'observed',
            payload: {
              role: role === 'user' || role === 'system' ? role : 'assistant',
              text: t.text,
              truncated: t.truncated,
            },
          },
        ];
      }
      case 'tool_use': {
        const toolId = readString(record, 'tool_id') ?? readString(record, 'tool_name') ?? 'tool';
        const input = truncateValue(record.parameters ?? null);
        return [
          {
            type: 'tool.called',
            native: 'tool_use',
            confidence: 'observed',
            payload: {
              toolId,
              name: readString(record, 'tool_name') ?? 'unknown',
              input: input.value,
            },
          },
        ];
      }
      case 'tool_result': {
        const toolId = readString(record, 'tool_id') ?? 'tool';
        const status = (readString(record, 'status') ?? 'success').toLowerCase();
        const output = truncateText(textOf(record.output));
        return [
          {
            type: 'tool.result',
            native: 'tool_result',
            confidence: 'observed',
            payload: {
              toolId,
              ok: OK_TOOL_STATUS.has(status),
              output: output.text,
              truncated: output.truncated,
            },
          },
        ];
      }
      case 'error':
        return this.onFatal(readString(record, 'message') ?? textOf(record.error), 'error');
      case 'result':
        return this.onResult(record);
      default:
        return [];
    }
  }

  finish(): { events: AdapterEvent[]; result: Partial<AdapterResult> } {
    if (!this.errorMessage) {
      const tail = this.textTail.join('\n');
      const fatal = this.textTail.find((l) => FATAL_TEXT.test(l));
      if (fatal) {
        this.errorMessage = fatal;
        this.errorCode = classifyError(fatal);
        this.status = 'failed';
      } else if (tail && this.status === 'failed') {
        this.errorMessage = tail;
        this.errorCode = classifyError(tail);
      }
    }
    const result: Partial<AdapterResult> = {
      usage: this.usage,
      model: this.model,
      turns: null,
      finalResponse: this.finalResponse,
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
      native: { sessionId: this.sessionId, resultStatus: this.resultStatus, stats: this.stats },
    };
    if (this.status) result.status = this.status;
    return { events: [], result };
  }

  private onText(line: string): AdapterEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    this.textTail.push(trimmed);
    if (this.textTail.length > 200) this.textTail.shift();
    if (!FATAL_TEXT.test(trimmed) || this.textErrorEmitted) return [];
    this.textErrorEmitted = true;
    return this.onFatal(trimmed, 'stderr-text');
  }

  private onFatal(message: string | undefined, native: string): AdapterEvent[] {
    const text = message && message.length > 0 ? message : 'gemini reported a fatal error';
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

  private onResult(record: Record<string, unknown>): AdapterEvent[] {
    const statsRecord = readRecord(record, 'stats');
    this.stats = statsRecord;
    this.resultStatus = readString(record, 'status') ?? null;
    if (this.resultStatus && !['success', 'ok', 'completed'].includes(this.resultStatus.toLowerCase())) {
      this.status = 'failed';
    }
    const usage: Usage = {};
    const input = readNumber(statsRecord, 'input_tokens');
    if (input !== undefined) usage.inputTokens = input;
    const output = readNumber(statsRecord, 'output_tokens');
    if (output !== undefined) usage.outputTokens = output;
    const cached = readNumber(statsRecord, 'cached');
    if (cached !== undefined) usage.cacheReadTokens = cached;
    const total = readNumber(statsRecord, 'total_tokens');
    if (total !== undefined) usage.totalTokens = total;
    if (Object.keys(usage).length === 0) return [];
    this.usage = usage;
    return [
      {
        type: 'model.response',
        native: 'result/stats',
        confidence: 'observed',
        payload: {
          ...(this.model ? { model: this.model } : {}),
          ...(this.resultStatus ? { stopReason: this.resultStatus } : {}),
          usage,
        },
      },
    ];
  }
}
