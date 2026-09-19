import { ClaudeCodeAdapter } from './claude-code/adapter.js';
import { CodexAdapter } from './codex/adapter.js';
import { FakeAdapter } from './fake/adapter.js';
import { GeminiCliAdapter } from './gemini-cli/adapter.js';
import { OpenCodeAdapter } from './opencode/adapter.js';
import type { AdapterRegistry, AgentAdapter } from './types.js';

/** Order matters for display: real CLIs first, the deterministic fake last. */
export const builtinAdapters: AgentAdapter[] = [
  new ClaudeCodeAdapter(),
  new CodexAdapter(),
  new GeminiCliAdapter(),
  new OpenCodeAdapter(),
  new FakeAdapter(),
];

export function createRegistry(adapters: readonly AgentAdapter[] = builtinAdapters): AdapterRegistry {
  const byId = new Map<string, AgentAdapter>();
  for (const adapter of adapters) byId.set(adapter.id, adapter);

  return {
    list: () => [...byId.values()],
    get: (id: string) => byId.get(id),
    register: (adapter: AgentAdapter) => {
      byId.set(adapter.id, adapter);
    },
  };
}
