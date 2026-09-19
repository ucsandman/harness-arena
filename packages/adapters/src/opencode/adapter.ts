import path from 'node:path';
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
import { OpenCodeParser } from './parser.js';

/**
 * `--standalone` runs a private server for this run only, `--auto` approves permissions that are not
 * explicitly denied, and `--format json` selects the JSONL stream.
 *
 * `opencode run --help` (OpenCode 2.0.4) documents the message as an optional positional argument
 * and says nothing about stdin, so the prompt is passed as the final argument and disclosed.
 */
const BASE_ARGS = ['run', '--standalone', '--format', 'json', '--auto'] as const;

const SHIM_EXTENSIONS = /\.(?:cmd|bat)$/i;
const LINE_BREAK = /[\n\r]/;

export interface OpenCodeAdapterOptions {
  /** defaults to the host platform; injected so the Windows-only limitation can be tested anywhere */
  platform?: NodeJS.Platform;
}

/**
 * OpenCode takes the prompt as an argv entry, and on Windows it is installed as a `.cmd` shim. A shim
 * can only be started through `cmd.exe`, which reads CR and LF as command separators and offers no way
 * to escape them, so a multi-line prompt cannot be delivered at all. Returns the reason, or null when
 * the run can proceed.
 */
export function unsupportedPromptReason(
  command: string,
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  if (!SHIM_EXTENSIONS.test(command)) return null;
  if (!LINE_BREAK.test(prompt)) return null;
  return `OpenCode is installed as a Windows ${path.extname(command).toLowerCase()} shim, which can only be started through cmd.exe, and cmd.exe cannot carry a line break in an argument. OpenCode run reads the prompt from argv (it documents no stdin input), so this multi-line task cannot be delivered. Use a single-line prompt, or install the native opencode binary.`;
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';
  readonly kind = 'cli' as const;
  readonly binaryNames = ['opencode'] as const;
  private readonly platform: NodeJS.Platform;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
  }

  capabilities(): AdapterCapabilities {
    return {
      tokens: 'observed',
      cost: 'observed',
      model: 'unavailable',
      toolCalls: 'observed',
      commands: 'unavailable',
      fileReads: 'unavailable',
      fileChanges: 'unavailable',
      subagents: 'unavailable',
      turns: 'observed',
      thinking: 'unavailable',
      contextCompaction: 'unavailable',
      userConfigIsolation: false,
      stdinPrompt: false,
      notes: [
        'the prompt is passed as the final positional argument: opencode run documents no stdin input',
        'OpenCode has no flag to ignore user-level config (~/.config/opencode), so this side is not isolated',
        'cost comes from the step_finish parts the CLI reports for the provider in use',
        'tool calls are reported by name only, so commands, file reads and file changes are n/a (core still derives file changes from git)',
        'reasoning tokens are reported separately by OpenCode and are not folded into output tokens',
        'on Windows, where OpenCode is a .cmd/.bat shim, a prompt containing a line break cannot be passed at all (cmd.exe treats CR and LF as command separators): such a run fails immediately with unsupported_prompt',
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
        notes: ['opencode not found on PATH (install: npm i -g opencode-ai)'],
      };
    }
    const version = await getSemverOf(binary, ['--version'], { env });
    return {
      id: this.id,
      installed: true,
      path: binary,
      version,
      auth: 'unknown',
      notes: ['auth is not probed: provider credentials belong to OpenCode and are never read by Arena'],
    };
  }

  async validate(detection: Detection): Promise<ValidationResult> {
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!detection.installed) problems.push('OpenCode CLI (opencode) is not installed or not on PATH');
    if (detection.installed) {
      warnings.push('the prompt is passed in argv because OpenCode run documents no stdin input');
      warnings.push('OpenCode cannot exclude user-level config, so this side is not isolated');
    }
    return { ok: problems.length === 0, problems, warnings };
  }

  async getVersion(): Promise<string | null> {
    const binary = await findBinary(this.binaryNames);
    return binary ? getSemverOf(binary) : null;
  }

  async prepare(ctx: PrepareContext): Promise<PreparedRun> {
    const binary =
      (await findBinary(this.binaryNames, ctx.env, { platform: this.platform })) ?? this.binaryNames[0];
    const args: string[] = [...BASE_ARGS];

    const model = ctx.agent.model ?? ctx.agentConfig?.model;
    if (model) args.push('--model', model);
    for (const extra of ctx.agentConfig?.args ?? []) args.push(extra);
    for (const extra of ctx.agent.args ?? []) args.push(extra);
    // Final positional argument: the task prompt. Never shell-interpolated.
    args.push(ctx.task.prompt);

    const { env, addedKeys } = buildChildEnv({
      base: ctx.env,
      agentConfig: ctx.agentConfig,
      agent: ctx.agent,
      runId: ctx.runId,
      side: ctx.side,
      workspace: ctx.workspace,
      harnessDir: ctx.harnessDir,
    });

    ctx.logger.debug('prepared opencode invocation', { argCount: args.length, envKeysAdded: addedKeys });

    const unsupported = unsupportedPromptReason(binary, ctx.task.prompt, this.platform);
    if (unsupported !== null) ctx.logger.warn('opencode cannot deliver this prompt', { reason: unsupported });

    return {
      command: binary,
      args,
      env,
      cwd: ctx.workspace,
      stdin: null,
      disclosure: {
        // The prompt is the last argument; it is excluded here so disclosure never prints the task body.
        command: binary,
        args: args.slice(0, -1),
        envKeysAdded: addedKeys,
        promptVia: 'arg',
        notes: [
          'the task prompt is the final command-line argument (OpenCode run documents no stdin input); it is passed as an argv entry, never through a shell',
          'run --help for OpenCode 2.0.4 lists "message... string Message to send (optional)" and no stdin option',
          ...(unsupported === null ? [] : [unsupported]),
        ],
      },
      userConfigIsolated: false,
    };
  }

  async execute(prepared: PreparedRun, ctx: ExecuteContext): Promise<AdapterResult> {
    // The prompt is the final argv entry (see prepare).
    const prompt = prepared.args.at(-1) ?? '';
    const unsupported = unsupportedPromptReason(prepared.command, prompt, this.platform);
    if (unsupported !== null) {
      // Fail the run here rather than letting the spawn be refused: the side records a clear reason
      // instead of a crash, and no process is started.
      ctx.logger.child({ adapter: this.id }).error('prompt cannot be delivered', { reason: unsupported });
      ctx.emit({
        type: 'error',
        payload: { code: 'unsupported_prompt', message: unsupported, fatal: true },
        confidence: 'derived',
      });
      return {
        status: 'failed',
        exitCode: null,
        finalResponse: null,
        usage: null,
        model: argValue(prepared.args, ['--model', '-m']),
        version: null,
        turns: null,
        errorCode: 'unsupported_prompt',
        errorMessage: unsupported,
        native: { unsupportedPrompt: 'line break in argv on a Windows shim' },
      };
    }

    return runCliProcess({
      adapterId: this.id,
      prepared,
      ctx,
      parser: this.createParser(),
      fallbackModel: argValue(prepared.args, ['--model', '-m']),
    });
  }

  async cleanup(): Promise<void> {
    // --standalone means the private server exits with the run.
  }

  createParser(): StreamParser {
    return new OpenCodeParser();
  }
}
