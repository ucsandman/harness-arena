import type { AdapterEvent, Usage } from '@harness-arena/protocol';
import type { AdapterResult, AdapterRunStatus, StreamParser } from '../types.js';
import {
  asRecord,
  classifyError,
  parseJsonLine,
  readArray,
  readBoolean,
  readNumber,
  readRecord,
  readString,
  textOf,
  truncateText,
  truncateValue,
} from '../shared.js';

/**
 * Translates Claude Code `--output-format stream-json --verbose` into protocol events.
 * Verified against packages/adapters/fixtures/claude-code/success.ndjson (Claude Code 2.1.278).
 */

const FILE_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const FILE_CHANGE_TOOLS: Record<string, 'create' | 'modify'> = {
  Write: 'create',
  Edit: 'modify',
  NotebookEdit: 'modify',
};

interface ToolState {
  name: string;
  isCommand: boolean;
  isSubagent: boolean;
}

function usageFrom(source: Record<string, unknown> | null, costUsd?: number): Usage | null {
  if (!source && costUsd === undefined) return null;
  const usage: Usage = {};
  const input = readNumber(source, 'input_tokens');
  if (input !== undefined) usage.inputTokens = input;
  const output = readNumber(source, 'output_tokens');
  if (output !== undefined) usage.outputTokens = output;
  const cacheRead = readNumber(source, 'cache_read_input_tokens');
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  const cacheWrite = readNumber(source, 'cache_creation_input_tokens');
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return Object.keys(usage).length > 0 ? usage : null;
}

function timeOf(record: Record<string, unknown>): number | undefined {
  const ts = readString(record, 'timestamp');
  if (!ts) return undefined;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export class ClaudeCodeParser implements StreamParser {
  private sessionId: string | null = null;
  private model: string | null = null;
  private version: string | null = null;
  private turns: number | null = null;
  private usage: Usage | null = null;
  private finalResponse: string | null = null;
  private subtype: string | null = null;
  private subagentStats: unknown = null;
  private apiErrorStatus: string | null = null;
  private status: AdapterRunStatus | undefined;
  private errorCode: string | null = null;
  private errorMessage: string | null = null;
  private sawResult = false;
  private readonly tools = new Map<string, ToolState>();
  /** message id -> serialized usage, so one message reported across several lines counts once */
  private readonly seenUsage = new Map<string, string>();
  private readonly stderrTail: string[] = [];
  private toolSeq = 0;

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
      case 'system':
        return this.onSystem(record);
      case 'assistant':
        return this.onAssistant(record);
      case 'user':
        return this.onUser(record);
      case 'rate_limit_event':
        return this.onRateLimit(record);
      case 'context':
        return this.onContext(record);
      case 'result':
        return this.onResult(record);
      default:
        return [];
    }
  }

  finish(): { events: AdapterEvent[]; result: Partial<AdapterResult> } {
    if (!this.sawResult && !this.errorMessage) {
      const tail = this.stderrTail.join('\n');
      if (tail) {
        this.errorCode = classifyError(tail);
        this.errorMessage = tail;
      }
    }
    const result: Partial<AdapterResult> = {
      usage: this.usage,
      model: this.model,
      version: this.version,
      turns: this.turns,
      finalResponse: this.finalResponse,
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
      native: {
        sessionId: this.sessionId,
        subtype: this.subtype,
        subagent_stats: this.subagentStats,
        apiErrorStatus: this.apiErrorStatus,
      },
    };
    if (this.status) result.status = this.status;
    return { events: [], result };
  }

  // ---- line handlers -------------------------------------------------------------------------

  private onSystem(record: Record<string, unknown>): AdapterEvent[] {
    const subtype = readString(record, 'subtype');
    if (subtype === 'init') {
      this.sessionId = readString(record, 'session_id') ?? null;
      this.model = readString(record, 'model') ?? null;
      this.version = readString(record, 'claude_code_version') ?? null;
      const tools = readArray(record, 'tools').filter((t): t is string => typeof t === 'string');
      return [
        {
          type: 'agent.started',
          native: 'system/init',
          confidence: 'observed',
          payload: {
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(this.model ? { model: this.model } : {}),
            ...(this.version ? { version: this.version } : {}),
            tools,
            cwdKnown: typeof record.cwd === 'string',
          },
        },
      ];
    }
    if (subtype === 'compact_boundary') {
      const meta = readRecord(record, 'compact_metadata');
      const trigger = readString(meta, 'trigger') ?? 'compact_boundary';
      return [
        {
          type: 'context.compacted',
          native: 'system/compact_boundary',
          confidence: 'observed',
          payload: { trigger },
        },
      ];
    }
    return [];
  }

  private onContext(record: Record<string, unknown>): AdapterEvent[] {
    const subtype = readString(record, 'subtype') ?? '';
    if (!subtype.includes('compact')) return [];
    return [
      {
        type: 'context.compacted',
        native: `context/${subtype}`,
        confidence: 'observed',
        payload: { trigger: subtype },
      },
    ];
  }

  private onAssistant(record: Record<string, unknown>): AdapterEvent[] {
    const message = readRecord(record, 'message');
    const at = timeOf(record);
    const parentToolId = readString(record, 'parent_tool_use_id') ?? null;
    const events: AdapterEvent[] = [];

    for (const raw of readArray(message, 'content')) {
      const block = asRecord(raw);
      if (!block) continue;
      switch (readString(block, 'type')) {
        case 'text': {
          const text = readString(block, 'text') ?? '';
          if (!text) break;
          const t = truncateText(text);
          events.push({
            type: 'agent.output',
            native: 'assistant/text',
            confidence: 'observed',
            ...(at === undefined ? {} : { at }),
            payload: { role: 'assistant', text: t.text, truncated: t.truncated },
          });
          break;
        }
        case 'thinking': {
          const thinking = readString(block, 'thinking') ?? '';
          events.push({
            type: 'agent.thinking',
            native: 'assistant/thinking',
            confidence: 'observed',
            ...(at === undefined ? {} : { at }),
            payload: { chars: thinking.length },
          });
          break;
        }
        case 'tool_use':
          events.push(...this.onToolUse(block, parentToolId, at));
          break;
        default:
          break;
      }
    }

    // Per-message usage. The `result` line carries the authoritative totals, so these are reported
    // as they arrive but never summed into the run total.
    const usageRecord = readRecord(message, 'usage');
    const usage = usageFrom(usageRecord);
    if (usage) {
      const messageId = readString(message, 'id') ?? `msg_${events.length}`;
      const fingerprint = JSON.stringify(usage);
      if (this.seenUsage.get(messageId) !== fingerprint) {
        this.seenUsage.set(messageId, fingerprint);
        const model = readString(message, 'model') ?? this.model ?? undefined;
        const stopReason = readString(message, 'stop_reason');
        events.push({
          type: 'model.response',
          native: 'assistant/usage',
          confidence: 'observed',
          ...(at === undefined ? {} : { at }),
          payload: {
            ...(model ? { model } : {}),
            ...(stopReason ? { stopReason } : {}),
            usage,
          },
        });
      }
    }
    return events;
  }

  private onToolUse(
    block: Record<string, unknown>,
    parentToolId: string | null,
    at: number | undefined,
  ): AdapterEvent[] {
    const toolId = readString(block, 'id') ?? `tool_${++this.toolSeq}`;
    const name = readString(block, 'name') ?? 'unknown';
    const input = asRecord(block.input);
    const truncatedInput = truncateValue(block.input);
    const events: AdapterEvent[] = [];

    this.tools.set(toolId, {
      name,
      isCommand: COMMAND_TOOLS.has(name),
      isSubagent: SUBAGENT_TOOLS.has(name),
    });

    events.push({
      type: 'tool.called',
      native: 'assistant/tool_use',
      confidence: 'observed',
      ...(at === undefined ? {} : { at }),
      payload: { toolId, name, input: truncatedInput.value, parentToolId },
    });

    if (COMMAND_TOOLS.has(name)) {
      const command = readString(input, 'command');
      if (command !== undefined) {
        const t = truncateText(command);
        events.push({
          type: 'command.started',
          native: `assistant/tool_use:${name}`,
          confidence: 'observed',
          ...(at === undefined ? {} : { at }),
          payload: { commandId: toolId, command: t.text },
        });
      }
    }

    if (FILE_READ_TOOLS.has(name)) {
      const target = readString(input, 'file_path') ?? readString(input, 'path');
      if (target) {
        events.push({
          type: 'file.read',
          native: `assistant/tool_use:${name}`,
          confidence: 'observed',
          ...(at === undefined ? {} : { at }),
          payload: { path: target },
        });
      }
    }

    const changeKind = FILE_CHANGE_TOOLS[name];
    if (changeKind) {
      const target = readString(input, 'file_path') ?? readString(input, 'notebook_path');
      if (target) {
        // The intent is observed; line counts and the final set of changes come from git in core.
        events.push({
          type: 'file.changed',
          native: `assistant/tool_use:${name}`,
          confidence: 'observed',
          ...(at === undefined ? {} : { at }),
          payload: { path: target, kind: changeKind },
        });
      }
    }

    if (SUBAGENT_TOOLS.has(name)) {
      const subName = readString(input, 'subagent_type') ?? readString(input, 'description');
      const description = readString(input, 'description');
      events.push({
        type: 'subagent.spawned',
        native: `assistant/tool_use:${name}`,
        confidence: 'observed',
        ...(at === undefined ? {} : { at }),
        payload: {
          subagentId: toolId,
          ...(subName ? { name: subName } : {}),
          ...(description ? { description } : {}),
        },
      });
    }

    return events;
  }

  private onUser(record: Record<string, unknown>): AdapterEvent[] {
    const message = readRecord(record, 'message');
    const at = timeOf(record);
    const events: AdapterEvent[] = [];

    for (const raw of readArray(message, 'content')) {
      const block = asRecord(raw);
      if (!block || readString(block, 'type') !== 'tool_result') continue;
      const toolId = readString(block, 'tool_use_id') ?? '';
      const isError = readBoolean(block, 'is_error') ?? false;
      const output = truncateText(textOf(block.content));
      const state = this.tools.get(toolId);

      events.push({
        type: 'tool.result',
        native: 'user/tool_result',
        confidence: 'observed',
        ...(at === undefined ? {} : { at }),
        payload: {
          toolId,
          ...(state ? { name: state.name } : {}),
          ok: !isError,
          output: output.text,
          truncated: output.truncated,
        },
      });

      if (state?.isCommand) {
        // Claude Code does not report the shell exit code in stream-json, so it stays null and
        // tool.result.ok carries success or failure.
        events.push({
          type: 'command.completed',
          native: 'user/tool_result',
          confidence: 'observed',
          ...(at === undefined ? {} : { at }),
          payload: { commandId: toolId, exitCode: null, output: output.text, truncated: output.truncated },
        });
      }
      if (state?.isSubagent) {
        events.push({
          type: 'subagent.completed',
          native: 'user/tool_result',
          confidence: 'observed',
          ...(at === undefined ? {} : { at }),
          payload: { subagentId: toolId, status: isError ? 'failed' : 'completed' },
        });
      }
    }
    return events;
  }

  private onRateLimit(record: Record<string, unknown>): AdapterEvent[] {
    const info = readRecord(record, 'rate_limit_info');
    const status = readString(info, 'status') ?? 'unknown';
    const kind = readString(info, 'rateLimitType') ?? 'unknown';
    return [
      {
        type: 'warning',
        native: 'rate_limit_event',
        confidence: 'observed',
        payload: { code: 'rate_limit', message: `rate limit window ${kind}: ${status}` },
      },
    ];
  }

  private onResult(record: Record<string, unknown>): AdapterEvent[] {
    this.sawResult = true;
    const events: AdapterEvent[] = [];
    const subtype = readString(record, 'subtype') ?? null;
    this.subtype = subtype;
    this.subagentStats = record.subagent_stats ?? null;
    this.apiErrorStatus = readString(record, 'api_error_status') ?? null;
    this.turns = readNumber(record, 'num_turns') ?? null;
    const isError = readBoolean(record, 'is_error') ?? false;
    const resultText = readString(record, 'result') ?? null;
    const usage = usageFrom(readRecord(record, 'usage'), readNumber(record, 'total_cost_usd'));
    this.usage = usage;

    if (resultText) {
      this.finalResponse = resultText;
      const t = truncateText(resultText);
      events.push({
        type: 'agent.output',
        native: 'result',
        confidence: 'observed',
        payload: { role: 'assistant', text: t.text, truncated: t.truncated, final: true },
      });
    }

    const stopReason = readString(record, 'stop_reason') ?? subtype ?? undefined;
    events.push({
      type: 'model.response',
      native: 'result/usage',
      confidence: 'observed',
      payload: {
        ...(this.model ? { model: this.model } : {}),
        ...(stopReason ? { stopReason } : {}),
        ...(usage ? { usage } : {}),
      },
    });

    if (subtype === 'error_max_turns') {
      events.push({
        type: 'limit.hit',
        native: 'result/error_max_turns',
        confidence: 'observed',
        payload: { kind: 'max_turns', detail: `stopped after ${String(this.turns ?? 'unknown')} turns` },
      });
      this.errorCode = 'max_turns';
    }
    if (subtype === 'error_max_budget') {
      events.push({
        type: 'limit.hit',
        native: 'result/error_max_budget',
        confidence: 'observed',
        payload: { kind: 'max_budget', detail: 'budget limit reached' },
      });
      this.errorCode = 'max_budget';
    }

    if (isError || (subtype !== null && subtype.startsWith('error_'))) {
      const message =
        readString(record, 'error') ??
        this.apiErrorStatus ??
        resultText ??
        subtype ??
        'run reported an error';
      this.status = 'failed';
      this.errorMessage = message;
      this.errorCode = this.errorCode ?? classifyError(message);
      events.push({
        type: 'error',
        native: `result/${subtype ?? 'error'}`,
        confidence: 'observed',
        payload: { code: this.errorCode, message: truncateText(message).text, fatal: true },
      });
    }

    for (const raw of readArray(record, 'permission_denials')) {
      const denial = asRecord(raw);
      const tool = readString(denial, 'tool_name') ?? readString(denial, 'tool') ?? 'unknown tool';
      events.push({
        type: 'human.intervention',
        native: 'result/permission_denials',
        confidence: 'observed',
        payload: { kind: 'permission', detail: `permission denied for ${tool}`, automated: true },
      });
    }

    return events;
  }
}
