import path from 'node:path';
import { defaultHome } from '@harness-arena/core';
import type { ArenaConfig, StateStore } from '@harness-arena/core';
import type { CliDeps } from './deps.js';
import { CliError } from './errors.js';

/**
 * ARENA_HOME and the server URL, plus the device token.
 *
 * The token lives in `<ARENA_HOME>/config.json`, which the core state store writes atomically with
 * mode 0600. Nothing in the CLI ever prints it: only the prefix stored beside it is displayed.
 */

export const DEFAULT_SERVER_URL = 'http://localhost:3000';

/** `--home` wins, then ARENA_HOME, then ~/.harness-arena. */
export function resolveHome(deps: CliDeps, flagHome?: string): string {
  if (flagHome && flagHome.trim().length > 0) return path.resolve(flagHome.trim());
  return defaultHome(deps.env);
}

function normalizeServerUrl(value: string, origin: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliError('the ' + origin + ' is not a URL: ' + value);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError('the ' + origin + ' must be http or https: ' + value);
  }
  return trimmed;
}

/** `--server` > ARENA_SERVER_URL > config.json > http://localhost:3000 */
export function resolveServerUrl(deps: CliDeps, config: ArenaConfig, flagServer?: string): string {
  if (flagServer && flagServer.trim().length > 0) return normalizeServerUrl(flagServer, '--server value');
  const fromEnv = deps.env.ARENA_SERVER_URL;
  if (fromEnv && fromEnv.trim().length > 0) return normalizeServerUrl(fromEnv, 'ARENA_SERVER_URL value');
  const fromConfig = config.serverUrl;
  if (typeof fromConfig === 'string' && fromConfig.trim().length > 0) {
    return normalizeServerUrl(fromConfig, 'server URL in config.json');
  }
  return DEFAULT_SERVER_URL;
}

export interface StoredLogin {
  token: string;
  tokenPrefix: string;
  serverUrl: string;
  user: { id: string; login: string; name: string | null };
  deviceName: string;
}

export async function readConfig(store: StateStore): Promise<ArenaConfig> {
  return store.getConfig();
}

export async function getToken(store: StateStore): Promise<string | null> {
  const config = await store.getConfig();
  const token = config.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export async function saveLogin(store: StateStore, login: StoredLogin): Promise<void> {
  await store.setConfig({
    token: login.token,
    tokenPrefix: login.tokenPrefix,
    serverUrl: login.serverUrl,
    user: login.user,
    deviceName: login.deviceName,
  });
}

export async function clearLogin(store: StateStore): Promise<void> {
  await store.setConfig({ token: null, tokenPrefix: null, user: null });
}

const MAX_RECENT = 8;

export function recentHarnesses(config: ArenaConfig): string[] {
  const value = config.recentHarnesses;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, MAX_RECENT);
}

/** Remembers harness sources so the interactive picker can offer "recently used". */
export async function rememberHarnesses(store: StateStore, sources: readonly string[]): Promise<void> {
  const config = await store.getConfig();
  const existing = recentHarnesses(config);
  const merged = [...sources.filter((s) => s.trim().length > 0 && s.trim() !== 'vanilla'), ...existing];
  const unique: string[] = [];
  for (const source of merged) {
    if (!unique.includes(source)) unique.push(source);
    if (unique.length >= MAX_RECENT) break;
  }
  await store.setConfig({ recentHarnesses: unique });
}
