import type { EvaluatorResult, RunArtifacts } from '@harness-arena/protocol';
import { normalizePath } from '../glob.js';
import type { Evaluator } from '../types.js';
import { changedFilePaths, countedLines, diffLines, makeResult, SIDES } from './shared.js';

export const DIFF_SIGNALS_ID = 'diff-signals';

/** A diff bigger than this is flagged for human attention. */
export const LARGE_DIFF_LINES = 1000;

const TEST_PATH = /(^|\/|[._-])(tests?|specs?|__tests__)($|\/|[._-])/i;
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i;
const TODO_LINE = /\b(TODO|FIXME|XXX)\b/;
const DEBUG_LINE =
  /(console\.(log|debug|dir)\s*\()|(^|[^\w.])print\s*\(|(^|[^\w.])println!\s*\(|System\.out\.print/;

export function isTestPath(filePath: string): boolean {
  return TEST_PATH.test(normalizePath(filePath));
}

export function isLockfilePath(filePath: string): boolean {
  return LOCKFILE.test(normalizePath(filePath));
}

export interface DiffSignal {
  id: string;
  label: string;
  value: number | boolean;
  note?: string;
}

export interface DiffSignalsDetails {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  signals: DiffSignal[];
}

/**
 * Deterministic observations about a diff. These are descriptive, never verdict-deciding: "touched the
 * tests" is neither good nor bad on its own, and the verdict engine ignores them on purpose.
 */
export function collectDiffSignals(artifacts: RunArtifacts): DiffSignalsDetails {
  const paths = changedFilePaths(artifacts).map(normalizePath);
  const lines = countedLines(artifacts);
  const content = diffLines(artifacts.diff);

  const testPaths = paths.filter(isTestPath);
  const deletedTests = artifacts.changedFiles
    .filter((f) => f.kind === 'delete' && isTestPath(f.path))
    .map((f) => normalizePath(f.path));
  const lockfiles = paths.filter(isLockfilePath);
  const todoAdded = content.added.filter((line) => TODO_LINE.test(line));
  const debugAdded = content.added.filter((line) => DEBUG_LINE.test(line));
  const totalLines = lines.added + lines.removed;

  const signals: DiffSignal[] = [
    { id: 'files_changed', label: 'Files changed', value: paths.length },
    { id: 'lines_added', label: 'Lines added', value: lines.added },
    { id: 'lines_removed', label: 'Lines removed', value: lines.removed },
    {
      id: 'touches_tests',
      label: 'Touches tests',
      value: testPaths.length > 0,
      ...(testPaths.length ? { note: testPaths.slice(0, 5).join(', ') } : {}),
    },
    {
      id: 'deletes_tests',
      label: 'Deletes tests',
      value: deletedTests.length > 0,
      ...(deletedTests.length ? { note: deletedTests.slice(0, 5).join(', ') } : {}),
    },
    {
      id: 'touches_lockfiles',
      label: 'Touches lockfiles',
      value: lockfiles.length > 0,
      ...(lockfiles.length ? { note: lockfiles.slice(0, 5).join(', ') } : {}),
    },
    { id: 'adds_todo', label: 'Adds TODO/FIXME lines', value: todoAdded.length },
    { id: 'adds_debug_logging', label: 'Adds debug logging', value: debugAdded.length },
    {
      id: 'large_diff',
      label: `Diff larger than ${LARGE_DIFF_LINES} lines`,
      value: totalLines > LARGE_DIFF_LINES,
      note: `${totalLines} line(s) changed`,
    },
    {
      id: 'empty_diff',
      label: 'Empty diff',
      value: paths.length === 0 && totalLines === 0,
    },
  ];

  return { filesChanged: paths.length, linesAdded: lines.added, linesRemoved: lines.removed, signals };
}

function summarize(details: DiffSignalsDetails): string {
  const flags = details.signals
    .filter((s) => typeof s.value === 'boolean' && s.value)
    .map((s) => s.label.toLowerCase());
  const head = `${details.filesChanged} file(s), +${details.linesAdded}/-${details.linesRemoved}`;
  return flags.length ? `${head}; ${flags.join('; ')}` : head;
}

/** Always applicable, always `passed`: it reports, it does not judge. */
export const diffSignalsEvaluator: Evaluator = {
  id: DIFF_SIGNALS_ID,
  kind: 'deterministic',
  applies: () => true,
  async run(ctx) {
    const results: EvaluatorResult[] = [];
    for (const side of SIDES) {
      const details = collectDiffSignals(ctx.sides[side].artifacts);
      results.push(
        makeResult({
          evaluatorId: DIFF_SIGNALS_ID,
          kind: 'deterministic',
          side,
          status: 'passed',
          score: null,
          summary: summarize(details),
          details,
          durationMs: 0,
        }),
      );
    }
    return results;
  },
};
