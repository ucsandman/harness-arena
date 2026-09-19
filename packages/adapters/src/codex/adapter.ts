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
import { CodexParser } from './parser.js';

/**
 * `exec` is the non-interactive mode, `--ephemeral` keeps no rollout on disk, and
 * `--ignore-user-config --ignore-rules` excludes the user's own Codex configuration so the harness
 * under test is the only difference between the two sides.
 */
const BASE_ARGS = [
  'exec',
  '--json',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--dangerously-bypass-approvals-and-sandbox',
] as const;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';
  readonly kind = 'cli' as const;
  readonly binaryNames = ['codex'] as const;

  capabilities(): AdapterCapabilities {
    return {
      tokens: 'observed',
      cost: 'unavailable',
      model: 'unavailable',
      toolCalls: 'observed',
      commands: 'observed',
      fileReads: 'unavailable',
      fileChanges: 'observed',
      subagents: 'unavailable',
      turns: 'observed',
      thinking: 'observed',
      contextCompaction: 'unavailable',
      userConfigIsolation: true,
      stdinPrompt: true,
      notes: [
        'Codex reports token counts but no cost, so cost is n/a rather than 0',
        'the model is not present in the JSON stream; Arena records the model it asked for',
        'Windows has no Codex sandbox, so --dangerously-bypass-approvals-and-sandbox is used; the workspace is a throwaway git worktree owned by Arena',
        'file reads are not reported as items, so files inspected is n/a',
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
        notes: ['codex not found on PATH (install: npm i -g @openai/codex)'],
      };
    }
    const version = await getSemverOf(binary, ['--version'], { env });
    return {
      id: this.id,
      installed: true,
      path: binary,
      version,
      auth: 'unknown',
      notes: ['auth is not probed: Arena never reads Codex credentials or runs a billable check'],
    };
  }

  async validate(detection: Detection): Promise<ValidationResult> {
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!detection.installed) problems.push('Codex CLI (codex) is not installed or not on PATH');
    if (detection.installed && !detection.version) warnings.push('could not determine the Codex version');
    return { ok: problems.length === 0, problems, warnings };
  }

  async getVersion(): Promise<string | null> {
    const binary = await findBinary(this.binaryNames);
    return binary ? getSemverOf(binary) : null;
  }

  async prepare(ctx: PrepareContext): Promise<PreparedRun> {
    const binary = (await findBinary(this.binaryNames, ctx.env)) ?? this.binaryNames[0];
    const args: string[] = [...BASE_ARGS, '-C', ctx.workspace];

    const model = ctx.agent.model ?? ctx.agentConfig?.model;
    if (model) args.push('-m', model);
    for (const extra of ctx.agentConfig?.args ?? []) args.push(extra);
    for (const extra of ctx.agent.args ?? []) args.push(extra);
    // A literal `-` makes codex read the prompt from stdin instead of argv.
    args.push('-');

    const { env, addedKeys } = buildChildEnv({
      base: ctx.env,
      agentConfig: ctx.agentConfig,
      agent: ctx.agent,
      runId: ctx.runId,
      side: ctx.side,
      workspace: ctx.workspace,
      harnessDir: ctx.harnessDir,
    });

    ctx.logger.debug('prepared codex invocation', { argCount: args.length, envKeysAdded: addedKeys });

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
          'the task prompt is read from stdin (trailing "-") and never appears in argv',
          'no output file is requested, so Codex writes nothing into the workspace beyond its own edits',
        ],
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
      fallbackModel: argValue(prepared.args, ['-m', '--model']),
    });
  }

  async cleanup(): Promise<void> {
    // --ephemeral leaves no rollout or session state behind.
  }

  createParser(): StreamParser {
    return new CodexParser();
  }
}
