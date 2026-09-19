/**
 * A deliberately tiny path matcher for assertion globs. Supports `*` (within one segment), `**`
 * (across segments) and `?`. A pattern without a wildcard matches the exact path or anything under it
 * (`src` matches `src/app.ts`). Separators are normalized, so Windows paths work unchanged.
 */

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function toRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      const doubled = pattern[i + 1] === '*';
      if (doubled) {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += (ch as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  const file = normalizePath(filePath);
  const glob = normalizePath(pattern);
  if (!glob) return false;
  if (!/[*?]/.test(glob)) return file === glob || file.startsWith(`${glob}/`);
  return toRegExp(glob).test(file);
}

export function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(filePath, p));
}
