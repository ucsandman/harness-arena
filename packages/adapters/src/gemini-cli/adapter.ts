import { findBinary, getSemverOf } from '../detect.js';
import { argValue, buildChildEnv, runCliProcess } from '../shared.js';
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
import { GeminiCliParser } from './parser.js';

/**
 * `--approval-mode yolo` is the non-interactive mode and `--skip-trust` avoids the folder-trust
 * prompt. Gemini CLI has no flag that ignores `~/.gemini`, so user-level configuration is part of
 * both sides of the battle and the report says so.
 */
const BASE_ARGS = ['--output-format', 'stream-json', '--approval-mode', 'yolo', '--skip-trust'] as const;

export class GeminiCliAdapter implements AgentAdapter {
  readonly id = 'gemini-cli';
  readonly displayName = 'Gemini CLI';
  readonly kind = 'cli' as const;
  readonly binaryNames = ['gemini'] as const;

  capabilities(): AdapterCapabilities {
    return {
      tokens: 'observed',
      cost: 'unavailable',
      model: 'observed',
      toolCalls: 'observed',
      commands: 'unavailable',
      fileReads: 'unavailable',
      fileChanges: 'unavailable',
      subagents: 'unavailable',
      turns: 'unavailable',
      thinking: 'unavailable',
      contextCompaction: 'unavailable',
      userConfigIsolation: false,
      stdinPrompt: true,
      notes: [
        'Gemini CLI has no flag to ignore ~/.gemini settings, extensions or MCP servers, so user-level config applies to this side and is recorded in EnvironmentInfo',
        'the stream reports tool calls but does not label shell commands, file reads or file changes, so those counts are n/a (core still derives file changes from git)',
        'no cost is reported',
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
        notes: ['gemini not found on PATH (install: npm i -g @google/gemini-cli)'],
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
        'auth is not probed; an ineligible or logged-out account surfaces as an auth error on the first run',
      ],
    };
  }

  async validate(detection: Detection): Promise<ValidationResult> {
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!detection.installed) problems.push('Gemini CLI (gemini) is not installed or not on PATH');
    if (detection.installed) {
      warnings.push('Gemini CLI cannot exclude user-level config (~/.gemini), so this side is not isolated');
    }
    return { ok: problems.length === 0, problems, warnings };
  }

  async getVersion(): Promise<string | null> {
    const binary = await findBinary(this.binaryNames);
    return binary ? getSemverOf(binary) : null;
  }

  async prepare(ctx: PrepareContext): Promise<PreparedRun> {
    const binary = (await findBinary(this.binaryNames, ctx.env)) ?? this.binaryNames[0];
    const args: string[] = [...BASE_ARGS];

    const model = ctx.agent.model ?? ctx.agentConfig?.model;
    if (model) args.push('-m', model);
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

    ctx.logger.debug('prepared gemini-cli invocation', { argCount: args.length, envKeysAdded: addedKeys });

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
        notes: [
          'the prompt is delivered on stdin; no -p flag is passed because its text would be appended to stdin',
          'user-level ~/.gemini configuration cannot be excluded by any CLI flag',
        ],
      },
      userConfigIsolated: false,
    };
  }

  async execute(prepared: PreparedRun, ctx: ExecuteContext): Promise<AdapterResult> {
    return runCliProcess({
      adapterId: this.id,
      prepared,
      ctx,
      parser: this.createParser(),
      fallbackModel: argValue(prepared.args, ['-m', '--model']),
    });
  }

  async cleanup(): Promise<void> {
    // Gemini CLI keeps its own session state under the user's home directory; Arena adds nothing.
  }

  createParser(): StreamParser {
    return new GeminiCliParser();
  }
}
