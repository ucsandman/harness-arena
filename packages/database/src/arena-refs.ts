import type { CompetitorRef, HarnessRef, HarnessSummary } from '@harness-arena/protocol';
import { harnessSlug } from './derive.js';

/**
 * Pure comparisons between the harness a competitive object NAMES and the harness a battle actually
 * RAN. A leaf module on purpose: challenges, tournaments, bounties and links all need it, and putting
 * it in any of them would make those four files import each other in a cycle.
 *
 * Nothing here trusts a label. A challenge is only linked to a battle when these functions say the
 * battle ran the harnesses the challenge names.
 */

/** github.com/Owner/Repo.git, trailing slashes and case are noise; the rest is identity. */
export function normalizeSource(source: string): string {
  return source
    .trim()
    .toLowerCase()
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/, '');
}

export interface SourceRef {
  source: string;
  commit?: string | null;
}

/**
 * Two references name the same harness when their sources match. Commits narrow that: when both sides
 * declare one, the shorter must be a prefix of the longer (the CLI may carry an abbreviated sha).
 * A reference with no commit matches any commit of the same source, which is what an open challenge
 * against "the latest main" means.
 */
export function sameHarness(a: SourceRef, b: SourceRef): boolean {
  if (normalizeSource(a.source) !== normalizeSource(b.source)) return false;
  const left = (a.commit ?? '').toLowerCase();
  const right = (b.commit ?? '').toLowerCase();
  if (left.length === 0 || right.length === 0) return true;
  return left.startsWith(right) || right.startsWith(left);
}

/** What a battle run says it used, in the shape sameHarness compares. */
export function refFromRun(harness: Pick<HarnessSummary, 'source' | 'commit'>): SourceRef {
  return { source: harness.source, commit: harness.commit };
}

export function refFromCompetitor(ref: CompetitorRef): SourceRef {
  return { source: ref.harness.source, commit: ref.harness.commit ?? null };
}

/** The same source-kind classification derive.ts applies to a battle record, from a bare ref. */
export function harnessKindFor(source: string): HarnessSummary['kind'] {
  const value = source.trim();
  if (value.toLowerCase() === 'vanilla') return 'vanilla';
  if (/github\.com[/:]/i.test(value)) return 'github';
  if (/^(https?|git|ssh):\/\//i.test(value) || /^git@/i.test(value) || /\.git$/i.test(value)) return 'git';
  return 'local';
}

/**
 * The catalogue slug a harness reference would land on, derived exactly as the battle pipeline does
 * (derive.ts `harnessSlug`), so a challenge created before the first battle still resolves to the
 * same `harnesses` row afterwards.
 */
export function slugForHarnessRef(ref: Pick<HarnessRef, 'source'>, label?: string): string {
  const kind = harnessKindFor(ref.source);
  return harnessSlug({ kind, source: ref.source, name: label ?? '' });
}

export function slugForCompetitor(ref: CompetitorRef): string {
  return slugForHarnessRef(ref.harness, ref.label);
}

/** A GitHub (or git) URL as a catalogue slug: `owner--repo`. Used by lineage parent resolution. */
export function slugForSourceUrl(url: string): string {
  return harnessSlug({ kind: harnessKindFor(url), source: url, name: '' });
}
