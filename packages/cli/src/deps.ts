import process from 'node:process';
import * as clack from '@clack/prompts';
import openExternal from 'open';
import {
  ARENA_VERSION,
  createStateStore,
  createUploader,
  runBattle,
  runDemoBattle,
} from '@harness-arena/core';
import { createRegistry, detectAgents } from '@harness-arena/adapters';
import type { AdapterRegistry, Detection } from '@harness-arena/adapters';

/**
 * Everything the commands reach for that is not pure. Tests build a CliDeps with fakes (a fake
 * registry, a fake fetch, a fake browser opener, a scripted prompter) and never touch the network,
 * the real agent CLIs, or the user's home directory.
 *
 * This module is a leaf: commands and program.ts import it, it imports none of them.
 */

export interface PromptOption<T> {
  value: T;
  label: string;
  hint?: string;
}

/** A prompt returning `null` means the user cancelled. */
export interface Prompter {
  intro(message: string): void;
  outro(message: string): void;
  note(body: string, title?: string): void;
  cancel(message: string): void;
  text(opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    initialValue?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string | null>;
  select<T extends string>(opts: {
    message: string;
    options: Array<PromptOption<T>>;
    initialValue?: T;
  }): Promise<T | null>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean | null>;
}

export interface CliDeps {
  runBattle: typeof runBattle;
  runDemoBattle: typeof runDemoBattle;
  createUploader: typeof createUploader;
  createStateStore: typeof createStateStore;
  createRegistry: () => AdapterRegistry;
  detectAgents: (registry: AdapterRegistry, env?: Record<string, string | undefined>) => Promise<Detection[]>;
  fetchImpl: typeof globalThis.fetch;
  /** opens a URL or a local file in the user's browser */
  openUrl: (target: string) => Promise<void>;
  prompter: Prompter;
  env: Record<string, string | undefined>;
  cwd: () => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** true when stdout is a terminal: menus, prompts and live status lines need it */
  isTTY: boolean;
  platform: string;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  /** aborted on the first Ctrl+C; passed to runBattle so the record is still saved */
  signal?: AbortSignal;
  arenaVersion: string;
}

function unwrap<T>(value: T | symbol): T | null {
  return clack.isCancel(value) ? null : (value as T);
}

/** The real prompter: @clack/prompts, with its cancel symbol mapped to null. */
export function createClackPrompter(): Prompter {
  return {
    intro: (message) => clack.intro(message),
    outro: (message) => clack.outro(message),
    note: (body, title) => clack.note(body, title),
    cancel: (message) => clack.cancel(message),
    text: async (opts) => {
      const validate = opts.validate;
      const result = await clack.text({
        message: opts.message,
        ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
        ...(opts.defaultValue === undefined ? {} : { defaultValue: opts.defaultValue }),
        ...(opts.initialValue === undefined ? {} : { initialValue: opts.initialValue }),
        ...(validate === undefined ? {} : { validate: (value: string | undefined) => validate(value ?? '') }),
      });
      return unwrap<string>(result);
    },
    select: async <T extends string>(opts: {
      message: string;
      options: Array<PromptOption<T>>;
      initialValue?: T;
    }): Promise<T | null> => {
      const result = await clack.select<string>({
        message: opts.message,
        options: opts.options.map((option) => ({
          value: String(option.value),
          label: option.label,
          ...(option.hint === undefined ? {} : { hint: option.hint }),
        })),
        ...(opts.initialValue === undefined ? {} : { initialValue: String(opts.initialValue) }),
      });
      const value = unwrap<string>(result);
      return value === null ? null : (value as T);
    },
    confirm: async (opts) => {
      const result = await clack.confirm({
        message: opts.message,
        ...(opts.initialValue === undefined ? {} : { initialValue: opts.initialValue }),
      });
      return unwrap<boolean>(result);
    },
  };
}

/** Fill in the real implementations for anything the caller did not override. */
export function resolveDeps(partial: Partial<CliDeps> = {}): CliDeps {
  return {
    runBattle,
    runDemoBattle,
    createUploader,
    createStateStore,
    createRegistry: () => createRegistry(),
    detectAgents,
    fetchImpl: (...args) => globalThis.fetch(...args),
    openUrl: async (target) => {
      await openExternal(target);
    },
    prompter: createClackPrompter(),
    env: process.env,
    cwd: () => process.cwd(),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    isTTY: process.stdout.isTTY === true,
    platform: process.platform,
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
    arenaVersion: ARENA_VERSION,
    ...partial,
  };
}
