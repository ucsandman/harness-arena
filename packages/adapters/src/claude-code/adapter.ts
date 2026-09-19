import { findBinary, getSemverOf } from '../detect.js';
import {
  argValue,
  buildChildEnv,
  resolveHarnessPath,
  resolveSystemPromptAppend,
  runCliProcess,
} from '../shared.js';
import type {
  AdapterCapabilities,
  AdapterResult,
  AgentAdapter,
  Detection,
  ExecuteContext,
  PrepareContext,
  PreparedRun,
  StreamParser,
  ValidationResult,
} from '../types.js';
import { ClaudeCodeParser } from './parser.js';

/** Flags Arena always passes: non-interactive, streaming, and user-level config excluded. */
const BASE_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
  '--no-session-persistence',
  '--setting-sources',
  'project,local',
  '--strict-mcp-config',
] as const;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly kind = 'cli' as const;
  readonly binaryNames = ['claude'] as const;

  capabilities(): AdapterCapabilities {
    return {
      tokens: 'observed',
      cost: 'observed',
      model: 'observed',
      toolCalls: 'observed',
      commands: 'observed',
      fileReads: 'observed',
      fileChanges: 'observed',
      subagents: 'observed',
      turns: 'observed',
      thinking: 'observed',
      contextCompaction: 'observed',
      userConfigIsolation: true,
      stdinPrompt: true,
      notes: [
        'cost is total_cost_usd, a list-price estimate computed by the CLI, not a subscription charge',
        'user-level settings and MCP servers are excluded (--setting-sources project,local --strict-mcp-config)',
        'shell exit codes are not reported in stream-json, so command.completed.exitCode is null',
      ],
    };
  }

  async detect(env: Record<string, string | undefined> = process.env): Promise<Detection> {
    const binary = await findBinary(this.binaryNames, env);
    if (!binary) {
      return {
        id: this.id,
        installed: false,
        path: null,
        version: null,
        auth: 'unknown',
        notes: ['claude not found on PATH (install: npm i -g @anthropic-ai/claude-code)'],
      };
    }
    const version = await getSemverOf(binary, ['--version'], { env });
    return {
      id: this.id,
      installed: true,
      path: binary,
      version,
      auth: 'unknown',
      notes: [
        'auth is not probed: the CLI offers no free check and Arena never reads credential files',
        ...(version === null ? ['claude --version produced no output'] : []),
      ],
    };
  }

  async validate(detection: Detection): Promise<ValidationResult> {
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!detection.installed) problems.push('Claude Code CLI (claude) is not installed or not on PATH');
    if (detection.installed && !detection.version)
      warnings.push('could not determine the Claude Code version');
    return { ok: problems.length === 0, problems, warnings };
  }

  async getVersion(): Promise<string | null> {
    const binary = await findBinary(this.binaryNames);
    return binary ? getSemverOf(binary) : null;
  }

  async prepare(ctx: PrepareContext): Promise<PreparedRun> {
    const binary = (await findBinary(this.binaryNames, ctx.env)) ?? this.binaryNames[0];
    const args: string[] = [...BASE_ARGS];
    const notes: string[] = [];

    const model = ctx.agent.model ?? ctx.agentConfig?.model;
    if (model) args.push('--model', model);
    if (ctx.limits.maxTurns !== undefined) args.push('--max-turns', String(ctx.limits.maxTurns));
    if (ctx.limits.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(ctx.limits.maxBudgetUsd));

    const settings = ctx.agentConfig?.settings;
    if (settings) {
      const resolved = resolveHarnessPath(settings, ctx.harnessDir);
      if (resolved) args.push('--settings', resolved);
      else notes.push(`ignored agentConfig.settings "${settings}": outside the harness directory`);
    }

    const mcpConfig = ctx.agentConfig?.mcpConfig;
    if (mcpConfig) {
      const resolved = resolveHarnessPath(mcpConfig, ctx.harnessDir);
      if (resolved) args.push('--mcp-config', resolved);
      else notes.push(`ignored agentConfig.mcpConfig "${mcpConfig}": outside the harness directory`);
    }

    const append = ctx.agentConfig?.systemPromptAppend;
    if (append) {
      const resolved = await resolveSystemPromptAppend(append, ctx.harnessDir);
      args.push('--append-system-prompt', resolved.text);
      notes.push(
        resolved.fromFile
          ? 'system prompt appendix loaded from the harness file named in agentConfig.systemPromptAppend'
          : 'system prompt appendix passed as literal text from agentConfig.systemPromptAppend',
      );
    }

    for (const extra of ctx.agentConfig?.args ?? []) args.push(extra);
    for (const extra of ctx.agent.args ?? []) args.push(extra);

    const { env, addedKeys } = buildChildEnv({
      base: ctx.env,
      agentConfig: ctx.agentConfig,
      agent: ctx.agent,
      runId: ctx.runId,
      side: ctx.side,
      workspace: ctx.workspace,
      harnessDir: ctx.harnessDir,
    });

    ctx.logger.debug('prepared claude-code invocation', { argCount: args.length, envKeysAdded: addedKeys });

    return {
      command: binary,
      args,
      env,
      cwd: ctx.workspace,
      stdin: ctx.task.prompt,
      disclosure: {
        command: binary,
        args,
        envKeysAdded: addedKeys,
        promptVia: 'stdin',
        notes: ['the task prompt is written to stdin and never appears in argv', ...notes],
      },
      userConfigIsolated: true,
    };
  }

  async execute(prepared: PreparedRun, ctx: ExecuteContext): Promise<AdapterResult> {
    return runCliProcess({
      adapterId: this.id,
      prepared,
      ctx,
      parser: this.createParser(),
      fallbackModel: argValue(prepared.args, ['--model']),
    });
  }

  async cleanup(): Promise<void> {
    // The CLI owns no Arena-side state: --no-session-persistence leaves nothing behind.
  }

  createParser(): StreamParser {
    return new ClaudeCodeParser();
  }
}
