import { createSilentLogger } from '@harness-arena/core';
import {
  GitHubSourceError,
  HarnessResolveError,
  HarnessSourceError,
  parseHarnessSource,
  resolveHarness,
} from '@harness-arena/harness';
import type { ResolvedHarness } from '@harness-arena/harness';
import type { HarnessRef } from '@harness-arena/protocol';
import type { CliDeps } from './deps.js';
import { CliError } from './errors.js';

/**
 * Harness resolution with CLI-shaped errors. `mode: 'inspect'` reads a GitHub harness over the REST
 * API without cloning; `mode: 'clone'` checks it out under ARENA_HOME so a battle can apply it.
 */

export function githubToken(deps: CliDeps): string | null {
  const token = deps.env.GITHUB_TOKEN ?? deps.env.GH_TOKEN;
  return token && token.trim().length > 0 ? token.trim() : null;
}

function friendly(err: unknown, source: string): CliError {
  if (err instanceof GitHubSourceError) {
    if (err.kind === 'rate_limit') {
      return new CliError(
        'GitHub rate-limited the inspection of ' +
          source +
          (err.resetAt ? ' (resets ' + err.resetAt + ')' : '') +
          '. Set GITHUB_TOKEN to raise the limit.',
      );
    }
    if (err.kind === 'not_found') {
      return new CliError(
        'GitHub has no readable repository at ' + source + ' (private repositories need GITHUB_TOKEN).',
      );
    }
    if (err.kind === 'auth') {
      return new CliError(
        'GitHub rejected the credentials while reading ' + source + '. Check GITHUB_TOKEN.',
      );
    }
    return new CliError('could not read ' + source + ' from GitHub: ' + err.message);
  }
  if (err instanceof HarnessResolveError) return new CliError(err.message);
  if (err instanceof HarnessSourceError) return new CliError(err.message);
  return new CliError('could not resolve the harness ' + source + ': ' + (err as Error).message);
}

export interface ResolveForCliOptions {
  home: string;
  agentId: string;
  ref?: string;
  mode?: 'clone' | 'inspect';
  trusted?: boolean;
}

export async function resolveHarnessForCli(
  deps: CliDeps,
  source: string,
  opts: ResolveForCliOptions,
): Promise<ResolvedHarness> {
  const ref: HarnessRef = {
    source,
    trusted: opts.trusted === true,
    ...(opts.ref ? { ref: opts.ref } : {}),
  };
  try {
    // Fails fast with a readable message on a malformed source before any network or disk work.
    parseHarnessSource(source);
    return await resolveHarness(ref, {
      home: opts.home,
      agentId: opts.agentId,
      logger: createSilentLogger(),
      fetchImpl: deps.fetchImpl,
      token: githubToken(deps),
      ...(opts.mode ? { mode: opts.mode } : {}),
    });
  } catch (err) {
    throw friendly(err, source);
  }
}
