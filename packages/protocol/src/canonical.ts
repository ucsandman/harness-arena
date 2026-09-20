/**
 * Stable JSON: keys sorted at every level, no whitespace. Two values with the same content produce the
 * same string regardless of key order in the source.
 *
 * It lives in its own dependency-free module because both `benchmarks.ts` (pack hashing) and
 * `integrity.ts` (matchup fingerprints) need it, and `integrity.ts` is imported by `battle.ts`:
 * importing it from `benchmarks.ts` would close the cycle battle → integrity → benchmarks → battle and
 * evaluate benchmark schemas before battle's schemas exist.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
