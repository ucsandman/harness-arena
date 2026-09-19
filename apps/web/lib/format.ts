import type { Side } from '@harness-arena/protocol';

export const NOT_AVAILABLE = 'n/a';

/** Duration as m:ss (h:mm:ss past an hour). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return NOT_AVAILABLE;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

/** Compact duration for axis ticks and inline notes: 420ms, 3.2s, 1m 04s. */
export function formatDurationShort(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return NOT_AVAILABLE;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Token counts as 182k / 1.24M. Exact below 1000. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NOT_AVAILABLE;
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) {
    const k = n / 1000;
    return `${abs < 10_000 ? k.toFixed(1) : String(Math.round(k))}k`;
  }
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** USD as $2.81. Keeps four decimals below a cent so a real number never reads as $0.00. */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NOT_AVAILABLE;
  if (n === 0) return '$0.00';
  const abs = Math.abs(n);
  if (abs < 0.01) return `$${n.toFixed(4)}`;
  if (abs >= 1000) return `$${formatNumber(Math.round(n))}`;
  return `$${n.toFixed(2)}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NOT_AVAILABLE;
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return NOT_AVAILABLE;
  return `${(fraction * 100).toFixed(digits)}%`;
}

const RELATIVE_UNITS: ReadonlyArray<readonly [limitMs: number, divisor: number, unit: string]> = [
  [60_000, 1000, 's'],
  [3_600_000, 60_000, 'm'],
  [86_400_000, 3_600_000, 'h'],
  [2_592_000_000, 86_400_000, 'd'],
];

/** "just now", "42s ago", "7m ago", "3d ago", then an ISO date. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return NOT_AVAILABLE;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return NOT_AVAILABLE;
  const delta = now - then;
  if (delta < 0) return formatUtcDate(iso);
  if (delta < 5000) return 'just now';
  for (const [limit, divisor, unit] of RELATIVE_UNITS) {
    if (delta < limit) return `${Math.floor(delta / divisor)}${unit} ago`;
  }
  return formatUtcDate(iso);
}

/** Deterministic UTC date (no locale drift between server render and client hydration). */
export function formatUtcDate(iso: string | null | undefined): string {
  if (!iso) return NOT_AVAILABLE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NOT_AVAILABLE;
  return d.toISOString().slice(0, 10);
}

export function formatUtcTime(iso: string | null | undefined): string {
  if (!iso) return NOT_AVAILABLE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NOT_AVAILABLE;
  return `${d.toISOString().slice(11, 19)}Z`;
}

export function sideName(side: Side): string {
  return side === 'a' ? 'A' : 'B';
}

/** Short commit hash for display; never pads what is not there. */
export function shortCommit(commit: string | null | undefined, length = 7): string {
  if (!commit) return NOT_AVAILABLE;
  return commit.length <= length ? commit : commit.slice(0, length);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return NOT_AVAILABLE;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
