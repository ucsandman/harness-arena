import { describe, expect, it } from 'vitest';
import {
  NOT_AVAILABLE,
  formatBytes,
  formatDuration,
  formatDurationShort,
  formatNumber,
  formatPercent,
  formatTokens,
  formatUsd,
  formatUtcDate,
  formatUtcTime,
  relativeTime,
  shortCommit,
  sideName,
} from '../lib/format';

describe('formatDuration', () => {
  it('renders m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59_400)).toBe('0:59');
    expect(formatDuration(274_100)).toBe('4:34');
  });

  it('renders h:mm:ss past an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });

  it('never invents a number for missing input', () => {
    expect(formatDuration(null)).toBe(NOT_AVAILABLE);
    expect(formatDuration(undefined)).toBe(NOT_AVAILABLE);
    expect(formatDuration(-1)).toBe(NOT_AVAILABLE);
    expect(formatDuration(Number.NaN)).toBe(NOT_AVAILABLE);
  });
});

describe('formatDurationShort', () => {
  it('scales the unit', () => {
    expect(formatDurationShort(420)).toBe('420ms');
    expect(formatDurationShort(3_200)).toBe('3.2s');
    expect(formatDurationShort(42_000)).toBe('42s');
    expect(formatDurationShort(64_000)).toBe('1m 04s');
    expect(formatDurationShort(null)).toBe(NOT_AVAILABLE);
  });
});

describe('formatTokens', () => {
  it('uses k and M above a thousand', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_500)).toBe('1.5k');
    expect(formatTokens(182_000)).toBe('182k');
    expect(formatTokens(1_240_000)).toBe('1.24M');
  });

  it('reports missing values as n/a', () => {
    expect(formatTokens(null)).toBe(NOT_AVAILABLE);
  });
});

describe('formatUsd', () => {
  it('renders dollars and cents', () => {
    expect(formatUsd(2.81)).toBe('$2.81');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1234.5)).toBe('$1,235');
  });

  it('keeps sub-cent values visible instead of rounding to zero', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
  });

  it('distinguishes unavailable from zero', () => {
    expect(formatUsd(null)).toBe(NOT_AVAILABLE);
    expect(formatUsd(undefined)).toBe(NOT_AVAILABLE);
  });
});

describe('formatNumber / formatPercent / formatBytes', () => {
  it('formats with grouping and units', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(null)).toBe(NOT_AVAILABLE);
    expect(formatPercent(0.82)).toBe('82%');
    expect(formatPercent(0.825, 1)).toBe('82.5%');
    expect(formatPercent(null)).toBe(NOT_AVAILABLE);
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z');

  it('uses relative units up to a month', () => {
    expect(relativeTime('2026-09-19T11:59:58.000Z', now)).toBe('just now');
    expect(relativeTime('2026-09-19T11:59:18.000Z', now)).toBe('42s ago');
    expect(relativeTime('2026-09-19T11:53:00.000Z', now)).toBe('7m ago');
    expect(relativeTime('2026-09-19T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2026-09-16T12:00:00.000Z', now)).toBe('3d ago');
  });

  it('falls back to an ISO date for old or invalid input', () => {
    expect(relativeTime('2026-01-01T00:00:00.000Z', now)).toBe('2026-01-01');
    expect(relativeTime('not a date', now)).toBe(NOT_AVAILABLE);
    expect(relativeTime(null, now)).toBe(NOT_AVAILABLE);
  });
});

describe('misc formatters', () => {
  it('formats UTC date and time deterministically', () => {
    expect(formatUtcDate('2026-09-19T14:02:11.000Z')).toBe('2026-09-19');
    expect(formatUtcTime('2026-09-19T14:02:11.000Z')).toBe('14:02:11Z');
    expect(formatUtcDate('nope')).toBe(NOT_AVAILABLE);
  });

  it('shortens commits without padding them', () => {
    expect(shortCommit('9f2c1ab4d7e6350c81b2a9f4e7d0c63b5a184f2e')).toBe('9f2c1ab');
    expect(shortCommit('abc')).toBe('abc');
    expect(shortCommit(null)).toBe(NOT_AVAILABLE);
  });

  it('names sides', () => {
    expect(sideName('a')).toBe('A');
    expect(sideName('b')).toBe('B');
  });
});
