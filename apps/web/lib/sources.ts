import { parseGitHubUrl } from '@harness-arena/harness';

/**
 * Classify a repository or harness source string the way the engine will, without touching the
 * filesystem. The web app must never resolve a local path against its own working directory: the
 * path in a spec belongs to the machine that will run the battle, not to this server.
 */

export type SourceKind = 'vanilla' | 'github' | 'git' | 'local';

export interface ClassifiedSource {
  kind: SourceKind;
  /** short human label: owner/repo, "vanilla", or the last path segment */
  name: string;
  /** canonical https URL when there is one */
  url: string | null;
}

const GIT_PROTOCOL = /^(https?|ssh|git):\/\//i;
const SCP_LIKE = /^[^@\s/\\]+@[^:\s/\\]+:.+$/;

export function classifySource(raw: string): ClassifiedSource {
  const value = (raw ?? '').trim();
  if (value.length === 0) return { kind: 'local', name: 'unknown', url: null };
  if (value.toLowerCase() === 'vanilla' || value.toLowerCase().startsWith('vanilla:')) {
    return { kind: 'vanilla', name: 'vanilla', url: null };
  }
  const github = parseGitHubUrl(value);
  if (github) {
    return { kind: 'github', name: `${github.owner}/${github.repo}`, url: github.url };
  }
  if (GIT_PROTOCOL.test(value) || SCP_LIKE.test(value)) {
    return { kind: 'git', name: lastSegment(value.replace(/\.git$/, '')), url: null };
  }
  return { kind: 'local', name: lastSegment(value), url: null };
}

/** Repository sources add one more kind: the literal "empty" for greenfield tasks. */
export function classifyRepository(raw: string): {
  kind: 'github' | 'git' | 'local' | 'empty';
  name: string;
} {
  const value = (raw ?? '').trim();
  if (value.length === 0 || value.toLowerCase() === 'empty')
    return { kind: 'empty', name: 'empty workspace' };
  const classified = classifySource(value);
  return { kind: classified.kind === 'vanilla' ? 'local' : classified.kind, name: classified.name };
}

function lastSegment(value: string): string {
  const parts = value.replace(/[/\\]+$/, '').split(/[/\\:]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part && part.length > 0) return part;
  }
  return value;
}
