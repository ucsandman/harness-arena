import type { KNOWN_AGENT_IDS } from '@harness-arena/protocol';

/**
 * What each official CLI actually reports, taken from docs/ADAPTERS.md (verified live 2026-09-19).
 * The form says this out loud so nobody picks an agent expecting a cost number it cannot produce.
 */
export interface AgentOption {
  id: (typeof KNOWN_AGENT_IDS)[number];
  label: string;
  vendor: string;
  note: string;
  /** can the CLI be told to ignore the user's own global config, so only the harness differs? */
  userConfigIsolated: boolean;
}

export const AGENT_OPTIONS: readonly AgentOption[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    vendor: 'Anthropic',
    note: 'Reports token usage, a list-price cost estimate, turns, tools, commands and subagents.',
    userConfigIsolated: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    note: 'Reports tokens per turn, commands and file changes. Cost is not reported, so it shows as n/a.',
    userConfigIsolated: true,
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    vendor: 'Google',
    note: 'Reports tokens, tool calls and duration. Cost is not reported; user config cannot be isolated.',
    userConfigIsolated: false,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    vendor: 'SST',
    note: 'Reports text, tool use and per-step tokens (cost only when the provider reports it).',
    userConfigIsolated: false,
  },
  {
    id: 'fake',
    label: 'Fake adapter',
    vendor: 'Harness Arena',
    note: 'Deterministic fixtures, no network and no model spend. Use it to try the whole pipeline.',
    userConfigIsolated: true,
  },
];
