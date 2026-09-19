import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BattleRecord, HarnessSummary, ResolvedTask } from '@harness-arena/protocol';

/**
 * Pure helpers that turn a BattleRecord into stable database keys. They are deterministic: the same
 * record always produces the same task id and harness slug, which is what makes upserts idempotent.
 */

export interface AgentCatalogEntry {
  displayName: string;
  vendor: string;
  homepage: string | null;
}

/** The agent CLIs Arena drives. Used by the seeder and when a battle references an unknown agent. */
export const AGENT_CATALOG: Record<string, AgentCatalogEntry> = {
  'claude-code': {
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    homepage: 'https://claude.com/claude-code',
  },
  codex: { displayName: 'Codex', vendor: 'OpenAI', homepage: 'https://developers.openai.com/codex/cli' },
  'gemini-cli': {
    displayName: 'Gemini CLI',
    vendor: 'Google',
    homepage: 'https://github.com/google-gemini/gemini-cli',
  },
  opencode: { displayName: 'OpenCode', vendor: 'SST', homepage: 'https://opencode.ai' },
  fake: { displayName: 'Fake adapter', vendor: 'Harness Arena', homepage: null },
};

export function agentCatalogEntry(agentId: string): AgentCatalogEntry {
  return AGENT_CATALOG[agentId] ?? { displayName: agentId, vendor: 'unknown', homepage: null };
}

export type HarnessFramework = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'multi' | 'unknown';

/** A harness seen only through one battle is attributed to the agent that ran it. */
export function frameworkForAgent(agentId: string): HarnessFramework {
  switch (agentId) {
    case 'claude-code':
    case 'codex':
    case 'gemini-cli':
    case 'opencode':
      return agentId;
    default:
      return 'unknown';
  }
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
}

function githubOwnerRepo(source: string): { owner: string; repo: string } | null {
  const match = /(?:github\.com[/:])([^/\s]+)\/([^/\s#?]+)/i.exec(source);
  if (!match) return null;
  const owner = slugPart(match[1] as string);
  const repo = slugPart(match[2] as string);
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Stable harness identity: `owner--repo` for GitHub and git sources, `vanilla` for agent defaults,
 * and a slugified name (or directory name) for local harnesses.
 */
export function harnessSlug(summary: Pick<HarnessSummary, 'kind' | 'source' | 'name'>): string {
  if (summary.kind === 'vanilla') return 'vanilla';
  const gh = githubOwnerRepo(summary.source);
  if (gh) return `${gh.owner}--${gh.repo}`;
  if (summary.kind === 'git') {
    const parts = summary.source
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .map(slugPart)
      .filter(Boolean);
    const tail = parts.slice(-2);
    if (tail.length === 2) return tail.join('--');
    if (tail.length === 1) return tail[0] as string;
  }
  const fromName = slugPart(summary.name);
  if (fromName) return fromName;
  const base = slugPart(path.basename(summary.source.replace(/[\\/]+$/, '')));
  return base || 'harness';
}

export function harnessDisplayName(summary: Pick<HarnessSummary, 'kind' | 'source' | 'name'>): string {
  if (summary.name) return summary.name;
  if (summary.kind === 'vanilla') return 'vanilla';
  const gh = githubOwnerRepo(summary.source);
  return gh ? `${gh.owner}/${gh.repo}` : path.basename(summary.source) || summary.source;
}

export function harnessSourceUrl(summary: Pick<HarnessSummary, 'kind' | 'source'>): string | null {
  if (summary.kind === 'github' || summary.kind === 'git') return summary.source;
  return null;
}

export function repositoryDisplayName(source: string, kind: BattleRecord['repository']['kind']): string {
  if (kind === 'empty') return 'empty repository';
  const gh = githubOwnerRepo(source);
  if (gh) return `${gh.owner}/${gh.repo}`;
  if (kind === 'local') return path.basename(source.replace(/[\\/]+$/, '')) || source;
  const tail = source
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter(Boolean)
    .slice(-2)
    .join('/');
  return tail || source;
}

/** Identical tasks share a row: the id is a hash of everything the agent receives. */
export function taskIdFor(task: ResolvedTask): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({ kind: task.source.kind, title: task.title, prompt: task.prompt, source: task.source }),
    )
    .digest('hex');
  return `tsk_${digest.slice(0, 24)}`;
}

export function repositoryIdFor(source: string): string {
  return `rep_${createHash('sha256').update(source).digest('hex').slice(0, 24)}`;
}

export function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
