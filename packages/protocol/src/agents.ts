import { z } from 'zod';

export const KNOWN_AGENT_IDS = ['claude-code', 'codex', 'gemini-cli', 'opencode', 'fake'] as const;
export const agentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,40}$/, 'agent id must be lowercase kebab-case');
export type AgentId = z.infer<typeof agentIdSchema>;
