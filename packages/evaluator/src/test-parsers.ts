import type { ParsedTestOutput, TestParser } from './types.js';

/** Parsers tried, in order, when `parser` is 'auto'. */
const AUTO_ORDER = ['vitest', 'jest', 'pytest', 'go', 'cargo', 'tap'] as const;

const EMPTY: ParsedTestOutput = {
  passed: null,
  failed: null,
  skipped: null,
  total: null,
  failingTests: [],
  parser: 'exit-code',
};

function countOf(text: string, word: string): number | null {
  const m = new RegExp(`(\\d+)\\s+${word}\\b`, 'i').exec(text);
  return m ? Number(m[1]) : null;
}

function collect(output: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of output.matchAll(re)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const name = raw.trim();
    if (name) out.push(name);
  }
  return out;
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

/** Strips vitest/jest timing suffixes like `12ms` or `(3 ms)` from a captured test name. */
function stripTiming(name: string): string {
  return name
    .replace(/\s*\(\s*\d+(?:\.\d+)?\s*m?s\s*\)\s*$/i, '')
    .replace(/\s+\d+(?:\.\d+)?\s*m?s$/i, '')
    .trim();
}

function sum(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

// ---- individual parsers ------------------------------------------------------------------------
// Each returns null when the output clearly is not from that tool, so 'auto' can move on.

/** ` Tests  1 failed | 3 passed (4)` plus ` FAIL  path > name` / ` x name` lines. */
function parseVitest(output: string): ParsedTestOutput | null {
  const m = /^[ \t]*Tests[ \t]+([^\n(]*)\((\d+)\)[ \t]*$/m.exec(output);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const seg = m[1];
  const total = Number(m[2]);
  const skipped = (countOf(seg, 'skipped') ?? 0) + (countOf(seg, 'todo') ?? 0);
  const failing = unique(
    [...collect(output, /^[ \t]*FAIL[ \t]+(.+)$/gm), ...collect(output, /^[ \t]*[×✕✗][ \t]+(.+)$/gm)].map(
      stripTiming,
    ),
  );
  return {
    passed: countOf(seg, 'passed') ?? 0,
    failed: countOf(seg, 'failed') ?? 0,
    skipped,
    total,
    failingTests: failing,
    parser: 'vitest',
  };
}

/** `Tests:       1 failed, 3 passed, 4 total` plus the failing bullet lines. */
function parseJest(output: string): ParsedTestOutput | null {
  const m = /^[ \t]*Tests:[ \t]+(.+)$/m.exec(output);
  if (!m || m[1] === undefined) return null;
  const seg = m[1];
  const passed = countOf(seg, 'passed') ?? 0;
  const failed = countOf(seg, 'failed') ?? 0;
  const skipped =
    (countOf(seg, 'skipped') ?? 0) + (countOf(seg, 'pending') ?? 0) + (countOf(seg, 'todo') ?? 0);
  const total = countOf(seg, 'total') ?? sum([passed, failed, skipped]);
  const bullets = collect(output, /^[ \t]*●[ \t]+(.+)$/gm)
    .map(stripTiming)
    .filter((name) => !/^Console$/i.test(name));
  return { passed, failed, skipped, total, failingTests: unique(bullets), parser: 'jest' };
}

/** `==== 1 failed, 3 passed in 0.52s ====` plus `FAILED path::name` lines. */
function parsePytest(output: string): ParsedTestOutput | null {
  let seg: string | null = null;
  for (const m of output.matchAll(/^=+[ \t]*(.*?)[ \t]*=+[ \t]*$/gm)) {
    const text = m[1];
    if (text === undefined) continue;
    if (/\d+\s+(passed|failed|error|errors|skipped|xfailed|xpassed)\b/i.test(text)) seg = text;
  }
  if (seg === null) return null;
  const passed = countOf(seg, 'passed') ?? 0;
  const failed = countOf(seg, 'failed') ?? 0;
  const skipped = countOf(seg, 'skipped') ?? 0;
  const errors = countOf(seg, 'errors') ?? countOf(seg, 'error') ?? 0;
  const xfailed = countOf(seg, 'xfailed') ?? 0;
  const xpassed = countOf(seg, 'xpassed') ?? 0;
  const failing = unique([
    ...collect(output, /^FAILED[ \t]+(\S+)/gm),
    ...collect(output, /^ERROR[ \t]+(\S+)/gm),
  ]);
  return {
    passed: passed + xpassed,
    failed: failed + errors,
    skipped: skipped + xfailed,
    total: passed + xpassed + failed + errors + skipped + xfailed,
    failingTests: failing,
    parser: 'pytest',
  };
}

/**
 * `--- FAIL: TestName (0.00s)` when `-v` is on; otherwise the per-package `ok`/`FAIL` lines
 * (in which case `failingTests` holds package names, the only names go prints).
 */
function parseGo(output: string): ParsedTestOutput | null {
  const passNames = collect(output, /^[ \t]*--- PASS:[ \t]+(\S+)/gm);
  const failNames = collect(output, /^[ \t]*--- FAIL:[ \t]+(\S+)/gm);
  const skipNames = collect(output, /^[ \t]*--- SKIP:[ \t]+(\S+)/gm);
  if (passNames.length || failNames.length || skipNames.length) {
    return {
      passed: passNames.length,
      failed: failNames.length,
      skipped: skipNames.length,
      total: passNames.length + failNames.length + skipNames.length,
      failingTests: unique(failNames),
      parser: 'go',
    };
  }
  // The trailing duration (or `(cached)`) is required so TAP's `ok 1 - name` lines cannot be mistaken
  // for go package results.
  const okPkgs = collect(output, /^ok[ \t]+(\S+)[ \t]+(?:\(cached\)|[\d.]+m?s)/gm);
  const failPkgs = collect(output, /^FAIL[ \t]+(\S+)[ \t]+(?:\[build failed\]|\(cached\)|[\d.]+m?s)/gm);
  if (!okPkgs.length && !failPkgs.length) return null;
  return {
    passed: okPkgs.length,
    failed: failPkgs.length,
    skipped: 0,
    total: okPkgs.length + failPkgs.length,
    failingTests: unique(failPkgs),
    parser: 'go',
  };
}

/** `test result: ok. 3 passed; 1 failed; 0 ignored; ...` summed over every test binary. */
function parseCargo(output: string): ParsedTestOutput | null {
  const segs = collect(output, /^test result:[ \t]*(?:ok|FAILED)\.[ \t]*(.+)$/gm);
  if (!segs.length) return null;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const seg of segs) {
    passed += countOf(seg, 'passed') ?? 0;
    failed += countOf(seg, 'failed') ?? 0;
    skipped += countOf(seg, 'ignored') ?? 0;
  }
  const failing = unique(collect(output, /^test[ \t]+(\S+)[ \t]+\.\.\.[ \t]+FAILED/gm));
  return {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    failingTests: failing,
    parser: 'cargo',
  };
}

/**
 * TAP (`# pass 3`, `# fail 1`, `not ok 2 - name`) and the `node --test` spec reporter, which is the
 * default on Node 20+ and prints `\u2139 pass 3` / `\u2139 fail 1` / `\u2716 name (1.2ms)` instead.
 */
function parseTap(output: string): ParsedTestOutput | null {
  const pass = /^[ \t]*(?:#|\u2139)[ \t]*pass[ \t]+(\d+)/m.exec(output);
  const fail = /^[ \t]*(?:#|\u2139)[ \t]*fail[ \t]+(\d+)/m.exec(output);
  if (pass?.[1] === undefined && fail?.[1] === undefined) return null;
  const passed = pass?.[1] === undefined ? 0 : Number(pass[1]);
  const failed = fail?.[1] === undefined ? 0 : Number(fail[1]);
  const skipMatch = /^[ \t]*(?:#|\u2139)[ \t]*(?:skipped|skip)[ \t]+(\d+)/m.exec(output);
  const todoMatch = /^[ \t]*(?:#|\u2139)[ \t]*todo[ \t]+(\d+)/m.exec(output);
  const skipped =
    (skipMatch?.[1] === undefined ? 0 : Number(skipMatch[1])) +
    (todoMatch?.[1] === undefined ? 0 : Number(todoMatch[1]));
  const totalMatch = /^[ \t]*(?:#|\u2139)[ \t]*tests[ \t]+(\d+)/m.exec(output);
  const total = totalMatch?.[1] === undefined ? passed + failed + skipped : Number(totalMatch[1]);
  const failing: string[] = [];
  for (const m of output.matchAll(/^not ok[ \t]+\d+[ \t]*-?[ \t]*(.*)$/gm)) {
    const raw = m[1];
    if (raw === undefined) continue;
    if (/#\s*(SKIP|TODO)\b/i.test(raw)) continue;
    const name = raw.replace(/\s*#.*$/, '').trim();
    if (name) failing.push(name);
  }
  for (const m of output.matchAll(/^[ \t]*\u2716[ \t]+(.+?)[ \t]+\([\d.]+ms\)[ \t]*$/gm)) {
    const name = m[1]?.trim();
    if (name) failing.push(name);
  }
  return { passed, failed, skipped, total, failingTests: unique(failing), parser: 'tap' };
}

const PARSERS: Record<(typeof AUTO_ORDER)[number], (output: string) => ParsedTestOutput | null> = {
  vitest: parseVitest,
  jest: parseJest,
  pytest: parsePytest,
  go: parseGo,
  cargo: parseCargo,
  tap: parseTap,
};

function hasCounts(parsed: ParsedTestOutput | null): parsed is ParsedTestOutput {
  return parsed !== null && parsed.total !== null && (parsed.passed !== null || parsed.failed !== null);
}

/**
 * Turns a test runner's console output into counts and failing test names. Never throws: output it
 * cannot read yields all-null counts and parser 'exit-code', so the caller falls back to the exit code.
 */
export function parseTestOutput(output: string, parser: TestParser): ParsedTestOutput {
  if (parser === 'exit-code') return { ...EMPTY };
  if (parser === 'auto') {
    for (const id of AUTO_ORDER) {
      const parsed = PARSERS[id](output);
      if (hasCounts(parsed)) return parsed;
    }
    return { ...EMPTY };
  }
  const parsed = PARSERS[parser](output);
  return parsed ?? { ...EMPTY, parser };
}
